// The NEAR AI veto: the request (same client, endpoint, key and model as POST /policy/draft), the verdict, every way
// it falls back to "no NEAR AI risk check" or fails closed, and the recorded exchanges played back without a key.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { NEAR_AI_MODEL, NEAR_AI_URL, NearAiClient, NearAiUnavailable } from '../nearai/client.ts';
import { completion, fixedFetch } from '../nearai/test-helpers.ts';
import { LOOP_RULES } from './decide.ts';
import { PASS_FACTS, T0, VETO_FACTS, VETO_FIXTURE, win } from './test-helpers.ts';
import {
  RecordedVeto, UNREADABLE_REPLY, VETO_SYSTEM_PROMPT, checkVeto, parseVerdict, promptKey, riskCheckWhy, vetoFacts, vetoJournalNumbers, vetoMessages,
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

test('no NEAR_AI_API_KEY: pass, "no NEAR AI risk check", nothing sent', async () => {
  const { fetch, sent } = fixedFetch(completion({ verdict: 'veto', reasons: ['x'] }));
  const r = await checkVeto(new NearAiClient({ apiKey: undefined, fetch }), PASS_FACTS, { now: T0 });
  assert.equal(sent.length, 0);
  assert.equal(r.checked, false);
  assert.deepEqual(r.veto, { verdict: 'pass', reasons: ['no NEAR AI risk check: NEAR_AI_API_KEY is not set'], model: NEAR_AI_MODEL, at: T0 });
  assert.equal(r.line, 'no NEAR AI risk check on NEAR: NEAR_AI_API_KEY is not set');
  assert.equal(r.exchange, null);
});

test('no answer within the timeout: pass, "no NEAR AI risk check"', async () => {
  const silent: VetoSource = { model: NEAR_AI_MODEL, configured: true, complete: () => new Promise(() => {}) };
  const started = Date.now();
  const r = await checkVeto(silent, PASS_FACTS, { now: T0, timeoutMs: 50 });
  assert.ok(Date.now() - started < 2_000);
  assert.equal(r.checked, false);
  assert.equal(r.veto.verdict, 'pass');
  assert.equal(r.line, 'no NEAR AI risk check on NEAR: no answer within 0.05 s');
  // The prompt is still kept for the journal, with no answer.
  assert.deepEqual(r.exchange, { key: promptKey(vetoMessages(PASS_FACTS)), model: NEAR_AI_MODEL, messages: vetoMessages(PASS_FACTS), response: null });
  assert.equal(r.outcome, 'timeout');
  assert.equal(r.latencyMs, null);
  assert.equal(riskCheckWhy(r, 'attested'), 'risk check timed out: passed');
  assert.equal(LOOP_RULES.vetoTimeoutMs, 5_000);
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
  assert.equal(riskCheckWhy(noKey, 'attested'), 'no NEAR AI key: not checked');
  const rejected = await ask({ error: { message: 'invalid api key' } }, 401);
  assert.equal(riskCheckWhy(rejected, 'attested'), 'NEAR AI key rejected (HTTP 401: invalid api key): not checked, passed');
  const down = await ask({ error: { message: 'overloaded' } }, 503);
  assert.equal(down.outcome, 'unavailable');
  assert.equal(riskCheckWhy(down, 'attested'), 'NEAR AI risk check unavailable (NEAR AI answered HTTP 503: overloaded): passed');
});

test('an error that quotes the key never carries it into a line, a reason or the exchange', async () => {
  const echo = fixedFetch({ error: { message: `bad key ${KEY}` } }, 500);
  const r = await checkVeto(new NearAiClient({ apiKey: KEY, fetch: echo.fetch }), PASS_FACTS, { now: T0 });
  assert.ok(!JSON.stringify(r).includes(KEY));
  assert.ok(!riskCheckWhy(r, 'attested').includes(KEY));
});

const ask = (body: unknown, status = 200) =>
  checkVeto(new NearAiClient({ apiKey: KEY, fetch: fixedFetch(body, status).fetch }), PASS_FACTS, { now: T0 });

test('NEAR AI down (HTTP or transport error): pass, "no NEAR AI risk check"', async () => {
  const down = await ask({ error: { message: 'overloaded' } }, 503);
  assert.equal(down.line, 'no NEAR AI risk check on NEAR: NEAR AI answered HTTP 503: overloaded');
  assert.equal(down.veto.verdict, 'pass');
  assert.equal(down.checked, false);
  const broken: VetoSource = {
    model: NEAR_AI_MODEL, configured: true,
    complete: async () => { throw new NearAiUnavailable('NEAR AI did not answer: connection reset'); },
  };
  const reset = await checkVeto(broken, PASS_FACTS, { now: T0 });
  assert.equal(reset.veto.verdict, 'pass');
  assert.equal(reset.line, 'no NEAR AI risk check on NEAR: NEAR AI did not answer: connection reset');
});

test('a key NEAR AI rejects (401, 403) passes unchecked, and the line says the key was rejected', async () => {
  for (const status of [401, 403]) {
    const r = await ask({ error: { message: 'invalid api key' } }, status);
    assert.equal(r.veto.verdict, 'pass');
    assert.equal(r.checked, false);
    assert.equal(r.line, `no NEAR AI risk check on NEAR: NEAR AI key rejected (HTTP ${status}: invalid api key)`);
    assert.deepEqual(r.veto.reasons, [`no NEAR AI risk check: NEAR AI key rejected (HTTP ${status}: invalid api key)`]);
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

  const other = await checkVeto(recorded, { ...PASS_FACTS, netAprPct: 9.5 }, { now: T0 });
  assert.equal(other.checked, false);
  assert.equal(other.line, 'no NEAR AI risk check on NEAR: no recorded NEAR AI risk check reply for this prompt');
});

test('a 200 reply that quotes the key is journaled and booked with the key cut, as errors are', async () => {
  const { fetch } = fixedFetch(completion(`{"verdict":"pass","reasons":["key ${KEY} seen"]}`));
  const r = await checkVeto(new NearAiClient({ apiKey: KEY, fetch }), PASS_FACTS, { now: T0 });
  assert.ok(!JSON.stringify(r).includes(KEY));
  assert.ok(!JSON.stringify(vetoJournalNumbers(r.exchange!)).includes(KEY));
  assert.match(String(vetoJournalNumbers(r.exchange!).vetoReply), /key … seen/);
});
