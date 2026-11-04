import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Attestation, AttestationRecording } from './attestation.ts';
import {
  ATTESTATION_URL, ATTESTATION_VALID_MS, Attestor, NRAS_URL, attestationLabel, attestationLine, fetchAttestation, parseQuote, readAttestationRecording,
  verifyAttestation,
} from './attestation.ts';
import { NEAR_AI_MODEL } from './client.ts';
import { newestAttestationFile } from './recorded.ts';

const FILE = newestAttestationFile();
const HOUR = 3_600_000;

function recorded(): AttestationRecording {
  assert.ok(FILE !== null, 'a recorded attestation is in fixtures/nearai (npm run record-nearai -w engine -- --attestation)');
  return readAttestationRecording(FILE);
}

type Evidence = { intel_quote: string; request_nonce: string; info: { tcb_info: string | Record<string, unknown> } };
const clone = (r: AttestationRecording): AttestationRecording => JSON.parse(JSON.stringify(r)) as AttestationRecording;
const gateway = (r: AttestationRecording) => (r.report as { gateway_attestation: Evidence }).gateway_attestation;
const model = (r: AttestationRecording, i = 0) => (r.report as { model_attestations: Evidence[] }).model_attestations[i]!;
const failedStep = (a: Attestation) => a.steps.find((s) => !s.ok);

test('the recorded report verifies: gateway and model TDX quotes to the Intel root, our nonce, the compose, the event log, the GPUs', () => {
  const rec = recorded();
  assert.equal(rec.model, NEAR_AI_MODEL);
  const a = verifyAttestation(rec, rec.at, 'recorded');
  assert.equal(a.why, null);
  assert.equal(a.verified, true);
  const steps = new Set(a.steps.map((s) => `${s.tee} ${s.step}`));
  for (const s of ['TDX quote', 'not debug', 'nonce and key', 'configuration', 'event log']) {
    assert.ok(steps.has(`gateway ${s}`), `gateway ${s}`);
    assert.ok(steps.has(`model 1 ${s}`), `model 1 ${s}`);
  }
  assert.ok(steps.has('model 1 GPUs'), 'the model TEE\'s GPUs, by NVIDIA NRAS');
  assert.ok(a.measurements.every((m) => /^0x[0-9a-f]{40}$/.test(m.signingAddress) && /^[0-9a-f]{64}$/.test(m.composeHash)));
  assert.ok((a.measurements.find((m) => m.tee === 'model 1')?.gpus ?? 0) > 0);
  // The line says what was verified and what was not.
  const line = attestationLine(a);
  assert.match(line, /^NEAR AI attestation of Qwen\/Qwen3-VL-30B-A3B-Instruct \(recorded .*\): verified TDX quote, not debug, nonce and key, configuration, event log, GPUs; /);
  assert.match(line, /not checked: TCB level and certificate revocation .*per-reply signatures are not fetched\)$/);
  // The quote's report data is the signing address, 12 zero bytes and our nonce.
  const q = parseQuote(gateway(rec).intel_quote);
  assert.equal(q.reportData.subarray(32).toString('hex'), rec.nonce);
});

test('a changed quote byte, another nonce or a changed compose fails, and says which step', () => {
  const rec = recorded();
  // One byte of the TD's MRTD (body offset 136, after the 48-byte header): the quote's signature no longer holds.
  const t1 = clone(rec);
  const hex = gateway(t1).intel_quote;
  const at = (48 + 136) * 2;
  gateway(t1).intel_quote = `${hex.slice(0, at)}${hex[at] === '0' ? '1' : '0'}${hex.slice(at + 1)}`;
  const a1 = verifyAttestation(t1, t1.at, 'recorded');
  assert.equal(a1.verified, false);
  assert.deepEqual([failedStep(a1)?.tee, failedStep(a1)?.step], ['gateway', 'TDX quote']);
  assert.match(a1.why!, /^gateway TDX quote: /);

  // A report replayed to another nonce: the report data does not bind ours.
  const t2 = { ...clone(rec), nonce: 'ab'.repeat(32) };
  const a2 = verifyAttestation(t2, t2.at, 'recorded');
  assert.equal(a2.verified, false);
  assert.equal(failedStep(a2)?.step, 'nonce and key');

  // A compose that is not the measured one.
  const t3 = clone(rec);
  const m = model(t3);
  const tcb = (typeof m.info.tcb_info === 'string' ? JSON.parse(m.info.tcb_info) : m.info.tcb_info) as Record<string, unknown>;
  tcb.app_compose = `${String(tcb.app_compose)} `;
  m.info.tcb_info = typeof m.info.tcb_info === 'string' ? JSON.stringify(tcb) : tcb;
  const a3 = verifyAttestation(t3, t3.at, 'recorded');
  assert.equal(a3.verified, false);
  assert.deepEqual([failedStep(a3)?.tee, failedStep(a3)?.step], ['model 1', 'configuration']);

  // No NRAS answer: the GPUs are not attested, so neither is the report.
  const a4 = verifyAttestation({ ...clone(rec), nras: [] }, rec.at, 'recorded');
  assert.equal(a4.verified, false);
  assert.match(a4.why!, /model 1 GPUs: NVIDIA NRAS did not answer/);

  // A model TEE with no GPU evidence is not attested (the gateway has none to give).
  const t6 = clone(rec);
  delete (model(t6) as { nvidia_payload?: unknown }).nvidia_payload;
  const a6 = verifyAttestation(t6, t6.at, 'recorded');
  assert.equal(a6.verified, false);
  assert.equal(a6.why, 'model 1 GPUs: no GPU evidence');
  assert.equal(attestationLabel({ ...a6, source: 'live' }, t6.at), 'TEE not attested: model 1 GPUs: no GPU evidence');

  // Ten years on, the PCK certificates have expired.
  const a5 = verifyAttestation(rec, rec.at + 10 * 365 * 24 * HOUR, 'recorded');
  assert.equal(a5.verified, false);
  assert.match(a5.why!, /TDX quote/);
});

test('no model attestation for the model: said so, never invented', () => {
  const rec = clone(recorded());
  (rec.report as { model_attestations: unknown[] }).model_attestations = [];
  const a = verifyAttestation(rec, rec.at, 'live');
  assert.equal(a.verified, false);
  assert.equal(a.why, `NEAR AI publishes no model attestation for ${NEAR_AI_MODEL}`);
  assert.equal(attestationLabel(a, rec.at), `TEE not attested: NEAR AI publishes no model attestation for ${NEAR_AI_MODEL}`);
  assert.equal(verifyAttestation({ ...rec, report: null }, rec.at, 'live').why, 'the attestation report is not an object');
});

test('the label: "TEE attested <when>" only for a live, verified report under 25 h old', () => {
  const rec = recorded();
  const live = verifyAttestation(rec, rec.at, 'live');
  // It names when the instances were attested: it does not say the reply came from them.
  assert.equal(attestationLabel(live, rec.at + HOUR), `TEE attested ${new Date(rec.at).toISOString().slice(0, 16).replace('T', ' ')} UTC`);
  assert.equal(attestationLabel(live, rec.at + ATTESTATION_VALID_MS + HOUR), 'TEE not attested: the last verified attestation is 26 h old');
  const played = verifyAttestation(rec, rec.at, 'recorded');
  assert.match(attestationLabel(played, rec.at), /^TEE not attested: replay plays an attestation recorded \d{4}-\d{2}-\d{2}, not a fresh one$/);
  assert.equal(attestationLabel(null, rec.at), 'TEE not attested: no attestation fetched yet');
  assert.equal(attestationLabel(null, rec.at, 'the attestation fetch failed: timeout'), 'TEE not attested: the attestation fetch failed: timeout');
  assert.equal(attestationLine(null, 'the attestation fetch failed: timeout'), 'NEAR AI attestation: TEE not attested: the attestation fetch failed: timeout');
});

test('the fetch: a fresh nonce on the public report URL (no key), the GPU evidence to NRAS; a stale report fails the nonce', async () => {
  const rec = recorded();
  const asked: { url: string; method: string; headers: Record<string, string> }[] = [];
  const fakeFetch = (async (url: URL | string, init?: RequestInit) => {
    asked.push({ url: String(url), method: init?.method ?? 'GET', headers: { ...(init?.headers as Record<string, string>) } });
    const body = String(url).startsWith(NRAS_URL) ? rec.nras[0] : rec.report;
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  const got = await fetchAttestation({ fetch: fakeFetch, now: rec.at + HOUR });
  const report = new URL(asked[0]!.url);
  assert.equal(`${report.origin}${report.pathname}`, ATTESTATION_URL);
  assert.equal(report.searchParams.get('model'), NEAR_AI_MODEL);
  assert.equal(report.searchParams.get('nonce'), got.nonce);
  assert.match(got.nonce, /^[0-9a-f]{64}$/);
  assert.notEqual(got.nonce, rec.nonce);
  assert.ok(asked.every((a) => !('authorization' in a.headers) && !('Authorization' in a.headers)), 'no key is sent');
  assert.ok(asked.slice(1).every((a) => a.url === NRAS_URL && a.method === 'POST'));
  // The answer here is the recorded one, to another nonce: it fails, as a replayed report must.
  const a = verifyAttestation(got, got.at, 'live');
  assert.equal(a.verified, false);
  assert.equal(failedStep(a)?.step, 'nonce and key');
});

test('Attestor: refresh never throws; a failed fetch is "TEE not attested: <why>", keeping a live result it had; replay plays a recorded one', async () => {
  const rec = recorded();
  let now = rec.at;
  const down = new Attestor({ now: () => now, fetch: (async () => { throw new Error('getaddrinfo ENOTFOUND'); }) as typeof fetch });
  assert.equal(await down.refresh(), null);
  assert.equal(down.label(), 'TEE not attested: the attestation fetch failed: getaddrinfo ENOTFOUND');
  assert.equal(down.line(), 'NEAR AI attestation: TEE not attested: the attestation fetch failed: getaddrinfo ENOTFOUND');
  const http = new Attestor({ now: () => now, fetch: (async () => new Response('busy', { status: 503 })) as typeof fetch });
  await http.refresh();
  assert.equal(http.label(), 'TEE not attested: the attestation fetch failed: NEAR AI attestation answered HTTP 503');

  const replay = new Attestor({ now: () => now, recorded: rec });
  assert.equal(replay.last?.verified, true);
  assert.equal(replay.last?.source, 'recorded');
  assert.match(replay.label(), /^TEE not attested: replay plays an attestation recorded /);
  assert.match(replay.line(), /^NEAR AI attestation of .* \(recorded .*\): verified /);
  now += 2 * ATTESTATION_VALID_MS;
  replay.stop();
});
