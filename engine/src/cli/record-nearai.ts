// Records real NEAR AI answers for the tests and replay to play back:
//   npm run record-nearai -w engine [-- --out <file>]                 the policy draft (spends tokens: needs the key)
//   npm run record-nearai -w engine -- --risk-checks [--out <file>]  the risk check prompts (spends tokens: needs the key)
//   npm run record-nearai -w engine -- --attestation [--out <file>]  the TEE attestation (no key, no tokens)
// The policy draft sends ETH_BTC_SENTENCE (src/nearai/recorded.ts) with the engine's own prompt and model, and writes
// NEAR AI's response body as it came, plus a `_comment` saying where it is from, to fixtures/nearai/policy-draft-eth-
// btc-<date>.json.
// --risk-checks sends every prompt of fixtures/nearai/SYNTHETIC-veto.json (the exact messages the risk check sends
// for those windows) as the risk check sends it, and writes each exchange with its real reply and latency to
// fixtures/nearai/risk-checks-<date>.json; RecordedVeto (tests, serve replay) then plays those over the synthetic ones.
// --attestation fetches NEAR AI Cloud's public attestation report for the model with a fresh nonce, asks NVIDIA's NRAS
// about its GPUs, verifies it (src/nearai/attestation.ts) and writes it gzipped to fixtures/nearai/attestation-
// <date>.json.gz; serve replay shows it as recorded, never as attested.
// Reads NEAR_AI_API_KEY from the environment or the repo's .env; the key is never printed or written.

import { existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { attestationLine, fetchAttestation, verifyAttestation, writeAttestationRecording } from '../nearai/attestation.ts';
import { NEAR_AI_MODEL, NearAiClient, completionContent, parseJsonObject } from '../nearai/client.ts';
import { draftMessages, parseDraftAnswer } from '../nearai/policy-draft.ts';
import { ETH_BTC_SENTENCE, NEARAI_FIXTURES, SYNTHETIC_RISK_CHECKS, attestationName, recordedName, riskChecksName } from '../nearai/recorded.ts';
import type { VetoExchange } from '../strategy/veto.ts';
import { VETO_MAX_TOKENS, parseVerdict, promptKey, readExchanges } from '../strategy/veto.ts';
import { errorMessage } from '../venues/recorder.ts';

const { values } = parseArgs({ options: { out: { type: 'string' }, 'risk-checks': { type: 'boolean' }, attestation: { type: 'boolean' } } });

try {
  if (values.attestation === true) await recordAttestation();
  else if (values['risk-checks'] === true) await recordRiskChecks(client());
  else await recordDraft(client());
} catch (err) {
  fail(errorMessage(err));
}

function client(): NearAiClient {
  const envFile = fileURLToPath(new URL('../../../.env', import.meta.url));
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const key = process.env.NEAR_AI_API_KEY?.trim();
  if (key === undefined || key === '') fail('NEAR_AI_API_KEY is not set (in the environment or the repo .env)');
  return new NearAiClient({ apiKey: key });
}

async function recordDraft(c: NearAiClient): Promise<void> {
  const out = resolve(values.out ?? join(NEARAI_FIXTURES, recordedName(Date.now())));
  const started = Date.now();
  const { content, raw } = await c.complete(draftMessages(ETH_BTC_SENTENCE), { json: true });
  const ms = Date.now() - started;
  // A reply that is not a draft is still written (the test then shows what the model did), but said so here.
  let check = 'a draft';
  try {
    const parsed = parseDraftAnswer(parseJsonObject(content));
    check = `a draft (${parsed.notes.length} type notes)`;
  } catch (err) {
    check = `NOT a draft: ${errorMessage(err)}`;
  }
  const body = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : { raw };
  const comment = `Recorded from NEAR AI Cloud (${c.model}) on ${new Date().toISOString()} by npm run record-nearai -w engine, `
    + 'for ETH_BTC_SENTENCE in src/nearai/recorded.ts.';
  writeFileSync(out, `${JSON.stringify({ _comment: comment, ...body }, null, 2)}\n`);
  console.log(`record-nearai: ${ms} ms, reply is ${check}`);
  console.log(content);
  console.log(`record-nearai: wrote ${out}`);
}

async function recordRiskChecks(c: NearAiClient): Promise<void> {
  const out = resolve(values.out ?? join(NEARAI_FIXTURES, riskChecksName(Date.now())));
  const prompts = readExchanges(join(NEARAI_FIXTURES, SYNTHETIC_RISK_CHECKS));
  const exchanges: VetoExchange[] = [];
  for (const [i, p] of prompts.entries()) {
    const started = performance.now();
    let response: unknown = null;
    let latencyMs: number | null = null;
    let shown: string;
    try {
      ({ raw: response } = await c.complete(p.messages, { json: true, maxTokens: VETO_MAX_TOKENS }));
      latencyMs = Math.round(performance.now() - started);
      const text = completionContent(response);
      let verdict: string;
      try {
        const v = parseVerdict(parseJsonObject(text));
        verdict = `${v.verdict}${v.reasons.length === 0 ? '' : `: ${v.reasons.join('; ')}`}`;
      } catch (err) {
        verdict = `unreadable (${errorMessage(err)})`;
      }
      shown = `${latencyMs} ms, ${verdict}`;
    } catch (err) {
      shown = `no answer: ${errorMessage(err)}`;
    }
    exchanges.push({ key: promptKey(p.messages), model: c.model, messages: p.messages, response, latencyMs });
    const facts = JSON.parse(p.messages[1]?.content ?? '{}') as { kind?: string; symbol?: string };
    console.log(`record-nearai: ${i + 1}/${prompts.length} ${facts.kind ?? '?'} ${facts.symbol ?? '?'}: ${shown}`);
  }
  const comment = `Recorded from NEAR AI Cloud (${c.model}) on ${new Date().toISOString()} by npm run record-nearai -w engine -- --risk-checks: `
    + `the prompts of ${SYNTHETIC_RISK_CHECKS} as the risk check sends them, each with its real reply and latency (ms).`;
  writeFileSync(out, `${JSON.stringify({ _comment: comment, exchanges }, null, 2)}\n`);
  console.log(`record-nearai: wrote ${out}`);
}

async function recordAttestation(): Promise<void> {
  const now = Date.now();
  const out = resolve(values.out ?? join(NEARAI_FIXTURES, attestationName(now)));
  const rec = await fetchAttestation({ model: NEAR_AI_MODEL, now });
  const a = verifyAttestation(rec, now, 'live');
  for (const s of a.steps) console.log(`record-nearai: ${s.ok ? 'ok  ' : 'FAIL'} ${s.tee} ${s.step}: ${s.detail}`);
  console.log(`record-nearai: ${attestationLine(a)}`);
  const comment = `Recorded from ${new URL('/v1/attestation/report', 'https://cloud-api.near.ai').href} (${rec.model}) and NVIDIA NRAS on `
    + `${new Date(now).toISOString()} by npm run record-nearai -w engine -- --attestation, with the nonce below. Public data: no key.`;
  writeAttestationRecording(out, rec, comment);
  console.log(`record-nearai: wrote ${out}`);
}

function fail(msg: string): never {
  console.error(`record-nearai: ${msg}`);
  process.exit(1);
}
