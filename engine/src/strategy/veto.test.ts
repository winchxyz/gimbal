// The NEAR AI risk check: the request (same client, endpoint, key and model as POST /policy/draft), the verdict, every
// way it fails closed (held for want of an answer, refused on an unreadable reply), the retry, and the recorded
// exchanges played back without a key (an unrecorded prompt passes in replay only).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { NEAR_AI_MODEL, NEAR_AI_URL, NearAiClient, NearAiUnavailable } from '../nearai/client.ts';
import { completion, fixedFetch } from '../nearai/test-helpers.ts';
import { LOOP_RULES } from './decide.ts';
import { PASS_FACTS, T0, VETO_FACTS, VETO_FIXTURE, win } from './test-helpers.ts';
import {
  MANUAL_MINIMUM, RISK_CHECK_CANCELLED, RecordedVeto, UNREADABLE_REPLY, UnrecordedPrompt, VETO_SYSTEM_PROMPT, checkVeto, riskCheckSource, parseVerdict, promptKey, riskCheckWhy, vetoFacts, vetoJournalNumbers, vetoMessages,
} from './veto.ts';
import type { VetoSource } from './veto.ts';

const KEY = 'test-key-not-real';

test('asks NEAR AI with the policy-draft client: same endpoint, model, key header, JSON output; a veto comes back as Window.veto', async () => {
  const answer = { verdict: 'veto', reasons: ['The spread this hour is 14 times its 7-day mean: a spike.'] };
  const { fetch, sent } = fixedFetch(completion(answer));
  const client = new NearAiClient({ apiKey: KEY, fetch });
  const r = await checkVeto(client, VETO_FACTS, { now: T0 });
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.url, NEAR_AI_URL);
  assert.equal(sent[0]!.headers.authorization, `Bearer ${KEY}`);
  assert.equal(sent[0]!.body.model, NEAR_AI_MODEL);
  assert.deepEqual(sent[0]!.body.response_format, { type: 'json_object' });
  assert.equal(sent[0]!.body.temperature, 0);
  assert.deepEqual(sent[0]!.body.messages, vetoMessages(VETO_FACTS));
  assert.deepEqual(r.veto, { verdict: 'veto', reasons: answer.reasons, model: NEAR_AI_MODEL, at: T0 });
  assert.equal(r.checked, true);
  assert.equal(r.line, 'NEAR AI risk check refused MEME: The spread this hour is 14 times its 7-day mean: a spike.');
  assert.equal(r.exchange?.key, promptKey(vetoMessages(VETO_FACTS)));
  assert.ok(!JSON.stringify(r).includes(KEY), 'the key is in no result');
});

test('a pass', async () => {
  const { fetch } = fixedFetch(completion({ verdict: 'pass', reasons: [] }));
  const r = await checkVeto(new NearAiClient({ apiKey: KEY, fetch }), PASS_FACTS, { now: T0 });
  assert.deepEqual(r.veto, { verdict: 'pass', reasons: [], model: NEAR_AI_MODEL, at: T0 });
  assert.equal(r.line, 'NEAR AI passed NEAR');
});

test('no NEAR_AI_API_KEY: held, never passed, nothing sent', async () => {
  const { fetch, sent } = fixedFetch(completion({ verdict: 'pass', reasons: [] }));
  const r = await checkVeto(new NearAiClient({ apiKey: undefined, fetch }), PASS_FACTS, { now: T0 });
  assert.equal(sent.length, 0);
  assert.equal(r.checked, false);
  assert.equal(r.held, true);
  assert.equal(r.attempts, 0);
  assert.equal(r.outcome, 'no-key');
  // Fail closed: what reads only the verdict refuses.
  assert.deepEqual(r.veto, { verdict: 'veto', reasons: ['the NEAR AI risk check did not answer: NEAR_AI_API_KEY is not set'], model: NEAR_AI_MODEL, at: T0 });
  assert.equal(r.line, 'the NEAR AI risk check did not answer on NEAR: NEAR_AI_API_KEY is not set: held, not passed: the act waits');
  assert.equal(r.exchange, null);
});

test('no answer within the timeout: asked once more, then held, never passed', async () => {
  let calls = 0;
  const silent: VetoSource = { model: NEAR_AI_MODEL, configured: true, complete: () => (calls++, new Promise(() => {})) };
  const started = Date.now();
  const r = await checkVeto(silent, PASS_FACTS, { now: T0, timeoutMs: 50 });
  assert.ok(Date.now() - started < 2_000);
  assert.equal(calls, 2, 'one retry');
  assert.equal(r.attempts, 2);
  assert.equal(r.checked, false);
  assert.equal(r.held, true);
  assert.equal(r.veto.verdict, 'veto');
  assert.equal(r.line, 'the NEAR AI risk check did not answer on NEAR: no answer within 0.05 s, asked 2 times: held, not passed: the act waits');
  // The prompt is still kept for the journal, with no answer.
  assert.deepEqual(r.exchange, { key: promptKey(vetoMessages(PASS_FACTS)), model: NEAR_AI_MODEL, messages: vetoMessages(PASS_FACTS), response: null });
  assert.equal(r.outcome, 'timeout');
  assert.equal(r.latencyMs, null);
  assert.equal(riskCheckWhy(r, 'attested'), 'the NEAR AI risk check did not answer (no answer within 0.05 s, asked 2 times): held, not passed: the act waits');
  assert.equal(LOOP_RULES.vetoTimeoutMs, 15_000);
  assert.equal(LOOP_RULES.vetoAttempts, 2);
});

test('a timeout then a readable answer on the retry: that answer counts (a pass passes, a veto refuses)', async () => {
  for (const verdict of ['pass', 'veto'] as const) {
    let calls = 0;
    const content = JSON.stringify({ verdict, reasons: verdict === 'veto' ? ['a spike'] : [] });
    const late: VetoSource = {
      model: NEAR_AI_MODEL, configured: true,
      complete: () => (++calls === 1 ? new Promise(() => {}) : Promise.resolve({ content, raw: { choices: [{ message: { content } }] } })),
    };
    const r = await checkVeto(late, PASS_FACTS, { now: T0, timeoutMs: 50 });
    assert.equal(calls, 2);
    assert.deepEqual([r.held, r.checked, r.outcome, r.veto.verdict, r.attempts], [false, true, verdict === 'pass' ? 'passed' : 'refused', verdict, 2]);
  }
});

test('the exchange goes into a journal entry: model, key, the exact prompt, the reply as it came, its latency', async () => {
  const { fetch } = fixedFetch(completion({ verdict: 'veto', reasons: ['a spike'] }));
  let clock = 1_000;
  const timer = () => (clock += 420);
  const r = await checkVeto(new NearAiClient({ apiKey: KEY, fetch }), VETO_FACTS, { now: T0, timer });
  assert.equal(r.latencyMs, 420);
  const n = vetoJournalNumbers(r.exchange!);
  assert.deepEqual(n, {
    vetoModel: NEAR_AI_MODEL, vetoKey: r.exchange!.key, vetoSystem: VETO_SYSTEM_PROMPT, vetoPrompt: vetoMessages(VETO_FACTS)[1]!.content,
    vetoReply: '{"verdict":"veto","reasons":["a spike"]}', vetoMs: 420,
  });
  assert.ok(!JSON.stringify(n).includes(KEY), 'the key is in no journal number');
  assert.equal(vetoJournalNumbers({ ...r.exchange!, response: null }).vetoReply, '');
  // The same object is what a replay fixture holds: JSON round trip, then played back.
  const played = await checkVeto(new RecordedVeto([JSON.parse(JSON.stringify(r.exchange))]), VETO_FACTS, { now: T0 });
  assert.deepEqual(played.veto, r.veto);
  // A recording plays back the latency it was recorded with.
  assert.equal(played.latencyMs, 420);
});

test('the why line: verdict and one-line reason, with the attestation for a reply that came, or why not checked', async () => {
  const { fetch } = fixedFetch(completion({ verdict: 'veto', reasons: ['a spike', '38.5 % in 24 h'] }));
  const refused = await checkVeto(new NearAiClient({ apiKey: KEY, fetch }), VETO_FACTS, { now: T0 });
  assert.equal(refused.outcome, 'refused');
  assert.equal(riskCheckWhy(refused, 'attested'), 'NEAR AI risk check refused (attested): a spike; 38.5 % in 24 h');
  const passed = await ask(completion({ verdict: 'pass', reasons: [] }));
  assert.equal(riskCheckWhy(passed, 'not attested: the TDX quote failed'), 'NEAR AI risk check passed (not attested: the TDX quote failed): no red flag named');
  const unreadable = await ask(completion('looks fine'));
  assert.equal(unreadable.outcome, 'unreadable');
  assert.match(riskCheckWhy(unreadable, 'attested'), /^NEAR AI risk check refused \(attested\): unreadable reply \(/);
  const noKey = await checkVeto(new NearAiClient({ apiKey: undefined }), PASS_FACTS, { now: T0 });
  assert.equal(riskCheckWhy(noKey, 'attested'), 'no NEAR AI key, so the NEAR AI risk check cannot answer: held, not passed: the act waits');
  const rejected = await ask({ error: { message: 'invalid api key' } }, 401);
  assert.equal(riskCheckWhy(rejected, 'attested'), 'NEAR AI key rejected (HTTP 401: invalid api key), so the NEAR AI risk check cannot answer: held, not passed: the act waits');
  const down = await ask({ error: { message: 'overloaded' } }, 503);
  assert.equal(down.outcome, 'unavailable');
  assert.equal(riskCheckWhy(down, 'attested'), 'the NEAR AI risk check did not answer (NEAR AI answered HTTP 503: overloaded, asked 2 times): held, not passed: the act waits');
  assert.equal(riskCheckWhy({ outcome: 'replay-unrecorded', reason: '' }, 'attested'),
    'no recorded NEAR AI risk check reply for this prompt: passed in replay only; live, the entry would wait');
});

test('an error that quotes the key never carries it into a line, a reason or the exchange', async () => {
  const echo = fixedFetch({ error: { message: `bad key ${KEY}` } }, 500);
  const r = await checkVeto(new NearAiClient({ apiKey: KEY, fetch: echo.fetch }), PASS_FACTS, { now: T0 });
  assert.ok(!JSON.stringify(r).includes(KEY));
  assert.ok(!riskCheckWhy(r, 'attested').includes(KEY));
});

const ask = (body: unknown, status = 200) =>
  checkVeto(new NearAiClient({ apiKey: KEY, fetch: fixedFetch(body, status).fetch }), PASS_FACTS, { now: T0 });

test('NEAR AI down (HTTP or transport error): asked once more, then held, never passed', async () => {
  const fetched = fixedFetch({ error: { message: 'overloaded' } }, 503);
  const down = await checkVeto(new NearAiClient({ apiKey: KEY, fetch: fetched.fetch }), PASS_FACTS, { now: T0 });
  assert.equal(fetched.sent.length, 2, 'one retry');
  assert.equal(down.line, 'the NEAR AI risk check did not answer on NEAR: NEAR AI answered HTTP 503: overloaded, asked 2 times: held, not passed: the act waits');
  assert.equal(down.veto.verdict, 'veto');
  assert.deepEqual([down.checked, down.held, down.outcome], [false, true, 'unavailable']);
  let calls = 0;
  const broken: VetoSource = {
    model: NEAR_AI_MODEL, configured: true,
    complete: async () => { calls++; throw new NearAiUnavailable('NEAR AI did not answer: connection reset'); },
  };
  const reset = await checkVeto(broken, PASS_FACTS, { now: T0 });
  assert.equal(calls, 2);
  assert.deepEqual([reset.held, reset.veto.verdict, reset.outcome], [true, 'veto', 'unavailable']);
  assert.equal(reset.line, 'the NEAR AI risk check did not answer on NEAR: NEAR AI did not answer: connection reset, asked 2 times: held, not passed: the act waits');
  // A transport error, then a readable pass on the retry: it passes.
  let tries = 0;
  const flaky: VetoSource = {
    model: NEAR_AI_MODEL, configured: true,
    complete: async () => {
      if (++tries === 1) throw new NearAiUnavailable('NEAR AI did not answer: connection reset');
      return { content: '{"verdict":"pass","reasons":[]}', raw: {} };
    },
  };
  const healed = await checkVeto(flaky, PASS_FACTS, { now: T0 });
  assert.deepEqual([healed.held, healed.outcome, healed.veto.verdict, healed.attempts], [false, 'passed', 'pass', 2]);
});

test('a key NEAR AI rejects (401, 403) is asked once and held, and the line says the key was rejected', async () => {
  for (const status of [401, 403]) {
    const fetched = fixedFetch({ error: { message: 'invalid api key' } }, status);
    const r = await checkVeto(new NearAiClient({ apiKey: KEY, fetch: fetched.fetch }), PASS_FACTS, { now: T0 });
    assert.equal(fetched.sent.length, 1, 'a rejected key is not asked again');
    assert.deepEqual([r.veto.verdict, r.checked, r.held, r.outcome], ['veto', false, true, 'key-rejected']);
    assert.equal(r.line, `the NEAR AI risk check did not answer on NEAR: NEAR AI key rejected (HTTP ${status}: invalid api key): held, not passed: the act waits`);
    assert.deepEqual(r.veto.reasons, [`the NEAR AI risk check did not answer: NEAR AI key rejected (HTTP ${status}: invalid api key)`]);
  }
});

test('a verdict in any case, padded or fenced is read', async () => {
  const veto = await ask(completion('{"verdict": "Veto", "reasons": ["a spike"]}'));
  assert.equal(veto.veto.verdict, 'veto');
  assert.equal(veto.line, 'NEAR AI risk check refused NEAR: a spike');
  assert.equal((await ask(completion('{"verdict": "VETO ", "reasons": ["a spike"]}'))).veto.verdict, 'veto');
  assert.equal((await ask(completion('{"verdict": " Pass\\n"}'))).veto.verdict, 'pass');
  const fenced = await ask(completion('```json\n{"verdict": "veto", "reasons": ["the 14-day spread is {negative}"]}\n```'));
  assert.deepEqual(fenced.veto.reasons, ['the 14-day spread is {negative}']);
  const bare = await ask(completion('```\n{"verdict": "pass", "reasons": []}\n```\n'));
  assert.equal(bare.veto.verdict, 'pass');
  assert.equal(bare.checked, true);
  // A key in a string that only looks like a duplicate is not one.
  assert.equal((await ask(completion('{"verdict": "pass", "reasons": ["\\"verdict\\": twice"]}'))).veto.verdict, 'pass');
});

test('a reply that cannot be read fails closed: a veto, "unreadable reply"', async () => {
  const cases: [unknown, RegExp][] = [
    [completion({ verdict: 'maybe' }), /the reply is not a verdict/],
    [completion('looks fine to me'), /has no JSON object/],
    [completion('{"verdict": "pass", "reasons": ["the spread'), /never closed/],
    [completion('{"verdict": "pass"}', 'length'), /cut off at its token limit/],
    [{ choices: [] }, /not a chat completion/],
    // The whole reply is read: a later object, or a veto anywhere, is never lost behind a first "pass".
    [completion('I could say {"verdict":"pass"} but no: {"verdict":"veto"}'), /holds 2 JSON objects/],
    [completion('{"verdict":"pass"} {"verdict":"pass"}'), /holds 2 JSON objects/],
    [completion('{"verdict":"pass","reasons":[],"draft":{"verdict":"Veto"}}'), /"pass" holds a "veto" inside it/],
    // Words outside the one object, or a key given twice (JSON.parse would keep only the last), are unreadable too.
    [completion('Verdict: veto. {"verdict":"pass"}'), /text outside its JSON object/],
    [completion('Here is my answer: {"verdict": "pass", "reasons": []} Thanks.'), /text outside its JSON object/],
    [completion('{"verdict":"veto","verdict":"pass"}'), /gives "verdict" twice/],
  ];
  for (const [body, why] of cases) {
    const r = await ask(body);
    assert.deepEqual(r.veto, { verdict: 'veto', reasons: [UNREADABLE_REPLY], model: NEAR_AI_MODEL, at: T0 });
    assert.equal(r.checked, true);
    assert.match(r.line, /^NEAR AI risk check refused NEAR: unreadable reply \(/);
    assert.match(r.line, why);
    assert.notEqual(r.exchange, null, 'what was asked is still kept for the record');
  }
  const thrown: VetoSource = { model: NEAR_AI_MODEL, configured: true, complete: async () => { throw new TypeError('boom'); } };
  assert.equal((await checkVeto(thrown, PASS_FACTS, { now: T0 })).veto.verdict, 'veto');
});

test('parseVerdict keeps at most 3 one-line reasons of at most 200 characters; a veto always has one', () => {
  const long = 'x'.repeat(250);
  const v = parseVerdict({ verdict: 'veto', reasons: ['a\nb', 7, '', long, 'c', 'd'] });
  assert.deepEqual(v.reasons, ['a b', `${'x'.repeat(200)}…`, 'c']);
  assert.deepEqual(parseVerdict({ verdict: 'veto' }).reasons, ['no reason given']);
  assert.deepEqual(parseVerdict({ verdict: 'pass', reasons: 'none' }).reasons, []);
});

test('the prompt is the facts alone, deterministic, with unknowns as null', () => {
  const a = vetoMessages(PASS_FACTS);
  assert.deepEqual(a, vetoMessages({ ...PASS_FACTS }));
  assert.equal(a[0]!.role, 'system');
  const facts = JSON.parse(a[1]!.content) as Record<string, unknown>;
  assert.equal(facts.asset, 'NEAR');
  assert.equal(facts.gross_apr_pct_this_hour, 25.81);
  assert.equal(facts.gross_apr_pct_7d, 19.08);
  assert.equal(facts.hours_in_a_row_above_minimum, 3);
  assert.deepEqual(facts.legs, [
    { venue: 'hyperliquid', side: 'long', open_interest_usd: 27_400_000, book_depth_usd: 41_000, fill_impact_bps: 1.2, price_move_24h_pct: -2.1, days_since_listing: null },
    { venue: 'phoenix', side: 'short', open_interest_usd: 1_583_197, book_depth_usd: 6_200, fill_impact_bps: 4.8, price_move_24h_pct: -2.1, days_since_listing: null },
  ]);
  assert.notEqual(promptKey(a), promptKey(vetoMessages(VETO_FACTS)));
});

test('vetoFacts: a window\'s numbers plus what Window does not carry', () => {
  const w = win('near-hyperliquid-phoenix', { grossAprPct: 25.81, grossApr7dPct: 19.08, netAprPct: 9 });
  const f = vetoFacts(w, {
    kind: 'enter', legUsd: 12, leverage: 1.5, minNetAprPct: 5, hoursAbove: 3, grossApr14dPct: 17.4,
    legs: {
      long: { openInterestUsd: 27_400_000, bookDepthUsd: 41_000, fillImpactBps: 1.2, priceMove24hPct: -2.1 },
      short: { openInterestUsd: 1_583_197, bookDepthUsd: 6_200, fillImpactBps: 4.8, priceMove24hPct: -2.1 },
    },
  });
  assert.deepEqual(f, PASS_FACTS);
  const bare = vetoFacts(w, { kind: 'rotate', legUsd: 12, leverage: 1.5, minNetAprPct: 5, hoursAbove: 4 });
  assert.equal(bare.grossApr14dPct, null);
  assert.deepEqual(bare.legs[1], {
    venue: 'phoenix', side: 'short', openInterestUsd: null, bookDepthUsd: null, fillImpactBps: null, priceMove24hPct: null, daysSinceListing: null,
  });
});

test('the recorded exchanges play back without a key; an unrecorded prompt is "no NEAR AI risk check"', async () => {
  const recorded = RecordedVeto.fromFile(VETO_FIXTURE);
  const body = JSON.parse(readFileSync(VETO_FIXTURE, 'utf8')) as { exchanges: { key: string; messages: unknown }[] };
  // Every recorded prompt is what vetoMessages builds today: a changed prompt would never be found again.
  assert.deepEqual(body.exchanges.slice(0, 2).map((e) => e.messages), [vetoMessages(PASS_FACTS), vetoMessages(VETO_FACTS)]);
  for (const e of body.exchanges) assert.equal(e.key, promptKey(e.messages as never));

  const pass = await checkVeto(recorded, PASS_FACTS, { now: T0 });
  assert.equal(pass.checked, true);
  assert.equal(pass.line, 'NEAR AI passed NEAR');
  const veto = await checkVeto(recorded, VETO_FACTS, { now: T0 });
  assert.equal(veto.veto.verdict, 'veto');
  assert.equal(veto.veto.reasons.length, 3);
  assert.match(veto.line, /^NEAR AI risk check refused MEME: The spread this hour, 310 % APR, is 14 times its 7-day mean/);
  // A recording of the live exchange plays back the same verdict.
  const { fetch } = fixedFetch(completion({ verdict: 'veto', reasons: ['r'] }));
  const live = await checkVeto(new NearAiClient({ apiKey: KEY, fetch }), VETO_FACTS, { now: T0 });
  const again = await checkVeto(new RecordedVeto([live.exchange!]), VETO_FACTS, { now: T0 + 1 });
  assert.deepEqual(again.veto, { ...live.veto, at: T0 + 1 });

  // An unrecorded prompt is no answer, as live: held (and not asked again, a recording never changes).
  const other = await checkVeto(recorded, { ...PASS_FACTS, netAprPct: 9.5 }, { now: T0 });
  assert.deepEqual([other.checked, other.held, other.outcome, other.veto.verdict, other.attempts], [false, true, 'unavailable', 'veto', 1]);
  assert.equal(other.line, 'the NEAR AI risk check did not answer on NEAR: no recorded NEAR AI risk check reply for this prompt: held, not passed: the act waits');
});

test('replay only (replayPassUnrecorded): an unrecorded prompt passes with the replay-only label; recorded replies still count', async () => {
  const replay = RecordedVeto.fromFile(VETO_FIXTURE, { replayPassUnrecorded: true });
  assert.equal(replay.replayPassUnrecorded, true);
  const other = await checkVeto(replay, { ...PASS_FACTS, netAprPct: 9.5 }, { now: T0 });
  assert.deepEqual([other.checked, other.held, other.outcome, other.veto.verdict], [false, false, 'replay-unrecorded', 'pass']);
  assert.equal(other.line, 'NEAR: no recorded NEAR AI risk check reply for this prompt: passed in replay only; live, the entry would wait');
  assert.equal(riskCheckWhy(other, ''), 'no recorded NEAR AI risk check reply for this prompt: passed in replay only; live, the entry would wait');
  // A recorded refusal is still a refusal in replay.
  assert.equal((await checkVeto(replay, VETO_FACTS, { now: T0 })).veto.verdict, 'veto');
  // Only a source that says it is replay passes an unrecorded prompt: the same error from any other source is no answer.
  const pretender: VetoSource = { model: NEAR_AI_MODEL, configured: true, complete: async () => { throw new UnrecordedPrompt(); } };
  const live = await checkVeto(pretender, PASS_FACTS, { now: T0 });
  assert.deepEqual([live.held, live.veto.verdict], [true, 'veto']);
  // The default recording (tests, anything not serve's replay) holds.
  assert.equal(RecordedVeto.fromFile(VETO_FIXTURE).replayPassUnrecorded, false);
});

test('a 200 reply that quotes the key is journaled and booked with the key cut, as errors are', async () => {
  const { fetch } = fixedFetch(completion(`{"verdict":"pass","reasons":["key ${KEY} seen"]}`));
  const r = await checkVeto(new NearAiClient({ apiKey: KEY, fetch }), PASS_FACTS, { now: T0 });
  assert.ok(!JSON.stringify(r).includes(KEY));
  assert.ok(!JSON.stringify(vetoJournalNumbers(r.exchange!)).includes(KEY));
  assert.match(String(vetoJournalNumbers(r.exchange!).vetoReply), /key … seen/);
});

test('vetoMessages: a manual act says the minimum is waived and carries no streak; an auto act keeps both, as recorded', () => {
  const auto = JSON.parse(vetoMessages(PASS_FACTS)[1]!.content) as Record<string, unknown>;
  assert.equal(auto.owner_minimum_net_apr_pct, PASS_FACTS.minNetAprPct);
  assert.equal(auto.hours_in_a_row_above_minimum, PASS_FACTS.hoursAbove);
  assert.equal('manual' in auto, false);
  assert.deepEqual(vetoMessages({ ...PASS_FACTS, manual: false }), vetoMessages(PASS_FACTS), 'manual false is an auto prompt');
  const manual = JSON.parse(vetoMessages({ ...PASS_FACTS, manual: true })[1]!.content) as Record<string, unknown>;
  assert.equal(manual.manual, true);
  assert.equal(manual.owner_minimum_net_apr_pct, MANUAL_MINIMUM);
  assert.equal('hours_in_a_row_above_minimum' in manual, false);
  assert.notEqual(promptKey(vetoMessages({ ...PASS_FACTS, manual: true })), promptKey(vetoMessages(PASS_FACTS)));
});

test('a timed-out attempt is aborted before the retry starts, so the two calls never overlap', async () => {
  const signals: AbortSignal[] = [];
  let open = 0;
  let overlap = false;
  const silent: VetoSource = {
    model: NEAR_AI_MODEL, configured: true,
    complete: (_m, o) => {
      signals.push(o!.signal!);
      if (open > 0) overlap = true;
      open++;
      return new Promise((_, reject) => o!.signal!.addEventListener('abort', () => {
        open--;
        reject(new Error('aborted'));
      }));
    },
  };
  const r = await checkVeto(silent, PASS_FACTS, { now: T0, timeoutMs: 30 });
  assert.equal(r.outcome, 'timeout');
  assert.equal(signals.length, 2);
  assert.ok(signals.every((s) => s.aborted), 'each attempt is aborted at its timeout');
  assert.equal(overlap, false, 'the retry starts only after the first call was aborted');
  assert.equal(open, 0);
});

test('a cancel ends the check at once: held, RISK_CHECK_CANCELLED, the call aborted, not asked again', async () => {
  const signals: AbortSignal[] = [];
  const silent: VetoSource = { model: NEAR_AI_MODEL, configured: true, complete: (_m, o) => (signals.push(o!.signal!), new Promise(() => {})) };
  const cancel = new AbortController();
  setTimeout(() => cancel.abort(), 20);
  const started = Date.now();
  const r = await checkVeto(silent, PASS_FACTS, { now: T0, timeoutMs: 120_000, signal: cancel.signal });
  assert.ok(Date.now() - started < 30_000, 'it does not wait for the 2 min timeout');
  assert.equal(r.held, true);
  assert.equal(r.reason, RISK_CHECK_CANCELLED);
  assert.equal(signals.length, 1, 'not asked again');
  assert.equal(signals[0]!.aborted, true);
  // Cancelled before it starts: nothing is asked.
  const before = await checkVeto(silent, PASS_FACTS, { now: T0, signal: AbortSignal.abort() });
  assert.equal(before.held, true);
  assert.equal(signals.length, 1);
});

test('the client ends its request when the risk check aborts it', async () => {
  let aborted = false;
  const hang = ((_url: unknown, init?: RequestInit) => new Promise<Response>((_, reject) => {
    init?.signal?.addEventListener('abort', () => {
      aborted = true;
      reject(init.signal!.reason);
    });
  })) as unknown as typeof fetch;
  const client = new NearAiClient({ apiKey: KEY, fetch: hang, timeoutMs: 20_000 });
  const r = await checkVeto(client, PASS_FACTS, { now: T0, timeoutMs: 30, attempts: 1 });
  assert.equal(r.outcome, 'timeout');
  assert.equal(aborted, true, 'the fetch was aborted at the 30 ms risk check timeout, not the client\'s 20 s');
});

test('riskCheckSource: testnet and mainnet always get NEAR AI (no key holds); replay with a key gets NEAR AI; only replay without a key plays recordings with the replay-only pass', async () => {
  const withKey = new NearAiClient({ apiKey: KEY, fetch: fixedFetch(completion({ verdict: 'pass', reasons: [] })).fetch });
  const noKey = new NearAiClient({ apiKey: undefined });
  let read = 0;
  const files = () => (read++, [VETO_FIXTURE]);
  for (const mode of ['testnet', 'mainnet'] as const) {
    for (const nearAi of [withKey, noKey]) {
      const s = riskCheckSource(mode, nearAi, files);
      assert.equal(s, nearAi, `${mode}: NEAR AI itself`);
      assert.notEqual((s as VetoSource).replayPassUnrecorded, true, `${mode}: never the replay-only pass`);
    }
    // With no key, every enter and rotate is held, never passed.
    const r = await checkVeto(riskCheckSource(mode, noKey, files), PASS_FACTS, { now: T0 });
    assert.equal(r.held, true);
    assert.equal(r.outcome, 'no-key');
  }
  assert.equal(riskCheckSource('replay', withKey, files), withKey, 'replay with a key: NEAR AI');
  assert.equal(read, 0, 'no recording read for any of those');
  const recorded = riskCheckSource('replay', noKey, files);
  assert.equal(read, 1);
  assert.ok(recorded instanceof RecordedVeto);
  assert.equal(recorded.replayPassUnrecorded, true);
  assert.ok((recorded as RecordedVeto).size > 0);
  const unrecorded = await checkVeto(recorded, { ...PASS_FACTS, symbol: 'NOT-RECORDED' }, { now: T0 });
  assert.equal(unrecorded.outcome, 'replay-unrecorded');
});
