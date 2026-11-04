// NEAR AI Cloud's TEE attestation for the model the risk check calls (docs.near.ai, "Verification": Cloud API gateway
// attestation, model attestations, quote, nonce and signer bindings). serve fetches it at start and once a day, checks
// what can be checked here, journals what was verified and what was not, and every risk check shows the result as
// "attested" or "not attested: <why>". A failed attestation never blocks trading: it is shown, honestly.
//
// The report: GET https://cloud-api.near.ai/v1/attestation/report?model=<id>&provider=near&signing_algo=ecdsa
// &include_tls_fingerprint=false&nonce=<32 random bytes, hex> with `x-no-aliasing: true` (public: no key needed). It
// holds `gateway_attestation` (the API gateway's TEE) and `model_attestations[]` (the model's TEEs). For each one this
// module checks, offline except the GPU step:
// 1. the Intel TDX quote's signature chain: the quote is signed by its attestation key, that key is bound into the
//    quoting enclave's report (sha256(key ‖ auth data) in its report data), that report is signed by the PCK
//    certificate, and the PCK chain ends at the Intel SGX Root CA pinned below; every certificate in its validity;
// 2. the TD is not a debug TD (TD attributes bit 0);
// 3. the quote's report data binds this request: bytes 0-19 the signing address, 20-31 zero, 32-63 our nonce (and
//    the echoed request_nonce is ours);
// 4. MRCONFIGID = 01 ‖ sha256(app_compose as sent) ‖ 15 zero bytes: the measured configuration is that compose;
// 5. the event log replays to RTMR0-3 of the quote, every RTMR3 event's digest recomputed from its payload, and its
//    compose-hash event equals sha256(app_compose);
// 6. GPUs (model only): nvidia_payload carries our nonce, and NVIDIA's NRAS answers x-nvidia-overall-att-result true.
//
// Not checked here, and said so on every line: the platform's TCB level and certificate revocation (Intel PCS
// collateral: TCB info, QE identity, CRLs); an allowlist of measurements or images (the compose's image digests are
// recorded, not judged); NRAS's JWT signature (its verdict is read over TLS); and that a given reply came from the
// attested instance (NEAR AI's per-reply signatures, /v1/signature/<chat id>, need the API key and are not fetched).

import { X509Certificate, createHash, createPublicKey, randomBytes, verify as verifySignature } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { errorMessage } from '../venues/recorder.ts';
import { NEAR_AI_MODEL } from './client.ts';

export const ATTESTATION_URL = 'https://cloud-api.near.ai/v1/attestation/report';
export const NRAS_URL = 'https://nras.attestation.nvidia.com/v3/attest/gpu';
/** serve fetches the attestation again after this. */
export const ATTESTATION_EVERY_MS = 24 * 3_600_000;
/** A verified attestation counts for the checks this long (a day and an hour: the daily fetch may run late). */
export const ATTESTATION_VALID_MS = 25 * 3_600_000;
const TIMEOUT_MS = 20_000;

/**
 * The Intel SGX Root CA (certificates.trustedservices.intel.com/Intel_SGX_Provisioning_Certification_RootCA.cer,
 * SHA-256 fingerprint 44:A0:19:6B:2B:99:F8:89:B8:E1:49:E9:5B:80:7A:35:0E:74:24:96:43:99:E8:85:A7:CB:B8:CC:FA:B6:74:D3).
 */
export const INTEL_SGX_ROOT_CA = `-----BEGIN CERTIFICATE-----
MIICjzCCAjSgAwIBAgIUImUM1lqdNInzg7SVUr9QGzknBqwwCgYIKoZIzj0EAwIw
aDEaMBgGA1UEAwwRSW50ZWwgU0dYIFJvb3QgQ0ExGjAYBgNVBAoMEUludGVsIENv
cnBvcmF0aW9uMRQwEgYDVQQHDAtTYW50YSBDbGFyYTELMAkGA1UECAwCQ0ExCzAJ
BgNVBAYTAlVTMB4XDTE4MDUyMTEwNDUxMFoXDTQ5MTIzMTIzNTk1OVowaDEaMBgG
A1UEAwwRSW50ZWwgU0dYIFJvb3QgQ0ExGjAYBgNVBAoMEUludGVsIENvcnBvcmF0
aW9uMRQwEgYDVQQHDAtTYW50YSBDbGFyYTELMAkGA1UECAwCQ0ExCzAJBgNVBAYT
AlVTMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEC6nEwMDIYZOj/iPWsCzaEKi7
1OiOSLRFhWGjbnBVJfVnkY4u3IjkDYYL0MxO4mqsyYjlBalTVYxFP2sJBK5zlKOB
uzCBuDAfBgNVHSMEGDAWgBQiZQzWWp00ifODtJVSv1AbOScGrDBSBgNVHR8ESzBJ
MEegRaBDhkFodHRwczovL2NlcnRpZmljYXRlcy50cnVzdGVkc2VydmljZXMuaW50
ZWwuY29tL0ludGVsU0dYUm9vdENBLmRlcjAdBgNVHQ4EFgQUImUM1lqdNInzg7SV
Ur9QGzknBqwwDgYDVR0PAQH/BAQDAgEGMBIGA1UdEwEB/wQIMAYBAf8CAQEwCgYI
KoZIzj0EAwIDSQAwRgIhAOW/5QkR+S9CiSDcNoowLuPRLsWGf/Yi7GSX94BgwTwg
AiEA4J0lrHoMs+Xo5o/sX6O9QWxHRAvZUGOdRQ7cvqRXaqI=
-----END CERTIFICATE-----`;

/** What this module never checks: on every attestation line and in the journal. */
export const NOT_CHECKED = [
  'TCB level and certificate revocation (Intel PCS collateral)',
  'an allowlist of measurements or images',
  'the NRAS token signature (its verdict is read over TLS)',
  'that each reply came from the attested instance (per-reply signatures are not fetched)',
] as const;

export interface AttestationStep {
  /** Which TEE: "gateway" or "model <n>". */
  tee: string;
  step: string;
  ok: boolean;
  detail: string;
}

/** The measurements of one attested TEE, as recorded (not judged against an allowlist). */
export interface TeeMeasurements {
  tee: string;
  signingAddress: string;
  mrtd: string;
  rtmr3: string;
  composeHash: string;
  osImageHash: string | null;
  appName: string | null;
  gpus: number | null;
}

export interface Attestation {
  model: string;
  /** ms, when the report was fetched. */
  at: number;
  nonce: string;
  /** live: fetched now with our nonce; recorded: a fixture fetched earlier (replay), not fresh. */
  source: 'live' | 'recorded';
  /** Every required step passed on the gateway and on every model candidate. */
  verified: boolean;
  /** The first step that failed, or why there is no report; null when verified. */
  why: string | null;
  steps: AttestationStep[];
  measurements: TeeMeasurements[];
  notChecked: readonly string[];
}

/** A recorded fetch: the report and NVIDIA's answer as they came, with the nonce they were asked with. */
export interface AttestationRecording {
  model: string;
  at: number;
  nonce: string;
  report: unknown;
  /** NRAS's answer per model candidate (index), or null when it was not asked or did not answer. */
  nras: (unknown | null)[];
}

// ---- the TDX quote ----

const HEADER = 48;
const BODY = 584;
/** TD report body offsets (Intel TDX DCAP quote v4). */
const TD = { tdAttributes: 120, mrtd: 136, mrconfigid: 184, rtmr0: 328, reportData: 520 } as const;

export interface ParsedQuote {
  signed: Buffer;
  tdAttributes: Buffer;
  mrtd: string;
  mrconfigid: string;
  rtmr: string[];
  reportData: Buffer;
  signature: Buffer;
  attestationKey: Buffer;
  qeReport: Buffer;
  qeSignature: Buffer;
  qeAuthData: Buffer;
  pckChain: string;
}

export function parseQuote(hex: string): ParsedQuote {
  const q = Buffer.from(hex, 'hex');
  if (q.length < HEADER + BODY + 4) throw new Error(`the quote is ${q.length} bytes, too short`);
  const version = q.readUInt16LE(0);
  const teeType = q.readUInt32LE(4);
  if (version !== 4) throw new Error(`quote version ${version}, not 4`);
  if (teeType !== 0x81) throw new Error(`TEE type 0x${teeType.toString(16)}, not TDX (0x81)`);
  const body = q.subarray(HEADER, HEADER + BODY);
  const sigLen = q.readUInt32LE(HEADER + BODY);
  const sd = q.subarray(HEADER + BODY + 4, HEADER + BODY + 4 + sigLen);
  if (sd.length !== sigLen || sigLen < 134) throw new Error('the quote\'s signature data is cut short');
  const certType = sd.readUInt16LE(128);
  if (certType !== 6) throw new Error(`certification data type ${certType}, not 6 (QE report)`);
  const qe = sd.subarray(134, 134 + sd.readUInt32LE(130));
  const authLen = qe.readUInt16LE(448);
  const inner = qe.subarray(450 + authLen);
  const innerType = inner.readUInt16LE(0);
  if (innerType !== 5) throw new Error(`inner certification data type ${innerType}, not 5 (PCK chain)`);
  return {
    signed: q.subarray(0, HEADER + BODY),
    tdAttributes: body.subarray(TD.tdAttributes, TD.tdAttributes + 8),
    mrtd: body.subarray(TD.mrtd, TD.mrtd + 48).toString('hex'),
    mrconfigid: body.subarray(TD.mrconfigid, TD.mrconfigid + 48).toString('hex'),
    rtmr: [0, 1, 2, 3].map((i) => body.subarray(TD.rtmr0 + 48 * i, TD.rtmr0 + 48 * (i + 1)).toString('hex')),
    reportData: body.subarray(TD.reportData, TD.reportData + 64),
    signature: sd.subarray(0, 64),
    attestationKey: sd.subarray(64, 128),
    qeReport: qe.subarray(0, 384),
    qeSignature: qe.subarray(384, 448),
    qeAuthData: qe.subarray(450, 450 + authLen),
    pckChain: inner.subarray(6, 6 + inner.readUInt32LE(2)).toString('utf8'),
  };
}

/** An uncompressed P-256 point (x ‖ y, 64 bytes) as a public key. */
function p256Key(raw: Buffer) {
  return createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: raw.subarray(0, 32).toString('base64url'), y: raw.subarray(32, 64).toString('base64url') }, format: 'jwk' });
}

function ecdsaOk(data: Buffer, signature: Buffer, key: ReturnType<typeof createPublicKey>): boolean {
  return verifySignature('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, signature);
}

/** The quote's signature chain up to the pinned Intel root, at `now`; null when it holds, else why not. */
export function quoteChainFailure(q: ParsedQuote, now: number): string | null {
  const pems = q.pckChain.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
  if (pems.length < 2) return `the PCK chain holds ${pems.length} certificate(s)`;
  const certs = pems.map((p) => new X509Certificate(p));
  const root = new X509Certificate(INTEL_SGX_ROOT_CA);
  const last = certs.at(-1)!;
  if (last.fingerprint256 !== root.fingerprint256) return `the PCK chain ends at "${last.subject.replace(/\n/g, ', ')}", not the Intel SGX Root CA`;
  for (let i = 0; i < certs.length - 1; i++) {
    if (!certs[i]!.verify(certs[i + 1]!.publicKey)) return `certificate ${i} of the PCK chain is not signed by the next one`;
  }
  if (!root.verify(root.publicKey)) return 'the Intel SGX Root CA is not self-signed';
  for (const c of certs) {
    if (now < Date.parse(c.validFrom) || now > Date.parse(c.validTo)) return `"${c.subject.split('\n')[0]}" is not valid at ${new Date(now).toISOString()}`;
  }
  if (!ecdsaOk(q.qeReport, q.qeSignature, certs[0]!.publicKey)) return 'the quoting enclave\'s report is not signed by the PCK certificate';
  const qeData = q.qeReport.subarray(320, 384);
  const bound = createHash('sha256').update(Buffer.concat([q.attestationKey, q.qeAuthData])).digest();
  if (!qeData.subarray(0, 32).equals(bound) || qeData.subarray(32).some((b) => b !== 0)) return 'the attestation key is not bound into the quoting enclave\'s report';
  if (!ecdsaOk(q.signed, q.signature, p256Key(q.attestationKey))) return 'the quote is not signed by its attestation key';
  return null;
}

// ---- the event log ----

interface LogEvent { imr: number; event_type: number; digest: string; event: string; event_payload: string }

function eventsOf(raw: unknown): LogEvent[] {
  const list = typeof raw === 'string' ? JSON.parse(raw) as unknown : raw;
  if (!Array.isArray(list)) throw new Error('the event log is not a list');
  return list as LogEvent[];
}

/** A dstack runtime (RTMR3) event's digest: sha384(event type, little endian ‖ ":" ‖ name ‖ ":" ‖ payload). */
export function runtimeEventDigest(e: Pick<LogEvent, 'event_type' | 'event' | 'event_payload'>): string {
  const type = Buffer.alloc(4);
  type.writeUInt32LE(e.event_type >>> 0);
  return createHash('sha384').update(Buffer.concat([type, Buffer.from(':'), Buffer.from(e.event, 'utf8'), Buffer.from(':'), Buffer.from(e.event_payload, 'hex')])).digest('hex');
}

/** Replays the log into RTMR0-3 (RTMR3's digests recomputed); null when it matches the quote, else why not. */
function eventLogFailure(events: readonly LogEvent[], rtmr: readonly string[], composeHash: string): string | null {
  const acc = [0, 1, 2, 3].map(() => Buffer.alloc(48));
  let composeEvent: string | null = null;
  for (const e of events) {
    if (!(e.imr >= 0 && e.imr <= 3)) return `an event names IMR ${String(e.imr)}`;
    let digest = e.digest;
    if (e.imr === 3) {
      const own = runtimeEventDigest(e);
      if (digest !== '' && digest.toLowerCase() !== own) return `RTMR3 event "${e.event}" does not hash to its digest`;
      digest = own;
      if (e.event === 'compose-hash') composeEvent = e.event_payload.toLowerCase();
    }
    acc[e.imr] = createHash('sha384').update(Buffer.concat([acc[e.imr]!, Buffer.from(digest, 'hex')])).digest();
  }
  for (let i = 0; i < 4; i++) if (acc[i]!.toString('hex') !== rtmr[i]) return `the event log does not replay to RTMR${i}`;
  if (composeEvent !== composeHash) return 'the compose-hash event is not sha256(app_compose)';
  return null;
}

// ---- one TEE ----

interface TeeEvidence {
  intel_quote?: unknown;
  event_log?: unknown;
  request_nonce?: unknown;
  signing_address?: unknown;
  signing_algo?: unknown;
  nvidia_payload?: unknown;
  info?: { tcb_info?: unknown; app_name?: unknown; os_image_hash?: unknown };
}

/** NRAS's overall GPU verdict from its answer (a list whose entry ["JWT", token] carries it); null when unreadable. */
export function nrasVerdict(answer: unknown): boolean | null {
  if (!Array.isArray(answer)) return null;
  const entry = answer.find((x): x is [string, string] => Array.isArray(x) && x[0] === 'JWT' && typeof x[1] === 'string');
  if (entry === undefined) return null;
  try {
    const claims = JSON.parse(Buffer.from(entry[1].split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;
    const v = claims['x-nvidia-overall-att-result'];
    return typeof v === 'boolean' ? v : null;
  } catch {
    return null;
  }
}

function checkTee(tee: string, ev: TeeEvidence, nonce: string, now: number, nras: unknown | null | undefined, steps: AttestationStep[]): TeeMeasurements | null {
  const step = (name: string, ok: boolean, detail: string) => steps.push({ tee, step: name, ok, detail });
  const address = typeof ev.signing_address === 'string' ? ev.signing_address.toLowerCase() : null;
  if (ev.signing_algo !== 'ecdsa' || address === null || !/^0x[0-9a-f]{40}$/.test(address)) {
    step('signing key', false, `no ecdsa signing address (${String(ev.signing_algo)})`);
    return null;
  }
  let q: ParsedQuote;
  try {
    if (typeof ev.intel_quote !== 'string') throw new Error('no intel_quote');
    q = parseQuote(ev.intel_quote);
  } catch (err) {
    step('TDX quote', false, `unreadable: ${errorMessage(err)}`);
    return null;
  }
  let chain: string | null;
  try {
    chain = quoteChainFailure(q, now);
  } catch (err) {
    chain = `unreadable: ${errorMessage(err)}`;
  }
  step('TDX quote', chain === null, chain ?? 'signed by its attestation key, bound by the quoting enclave, PCK chain to the Intel SGX Root CA');
  const debug = (q.tdAttributes[0]! & 1) === 1;
  step('not debug', !debug, debug ? 'the TD is a debug TD' : 'TD attributes: not a debug TD');
  const want = Buffer.concat([Buffer.from(address.slice(2), 'hex'), Buffer.alloc(12), Buffer.from(nonce, 'hex')]);
  const echoed = typeof ev.request_nonce === 'string' && ev.request_nonce.toLowerCase() === nonce.toLowerCase();
  const bound = q.reportData.equals(want);
  step('nonce and key', bound && echoed, bound && echoed ? `report data binds signing address ${address} and our nonce`
    : !echoed ? 'the echoed nonce is not ours' : 'the report data does not bind the signing address and our nonce');
  let tcb: Record<string, unknown> = {};
  try {
    const raw = ev.info?.tcb_info;
    tcb = (typeof raw === 'string' ? JSON.parse(raw) : raw ?? {}) as Record<string, unknown>;
  } catch {
    // tcb stays empty: the compose step fails below
  }
  const compose = typeof tcb.app_compose === 'string' ? tcb.app_compose : null;
  const composeHash = compose === null ? '' : createHash('sha256').update(compose, 'utf8').digest('hex');
  const configOk = compose !== null && q.mrconfigid === `01${composeHash}${'00'.repeat(15)}`;
  step('configuration', configOk, configOk ? `MRCONFIGID = compose hash ${composeHash}` : compose === null ? 'no app_compose' : 'MRCONFIGID is not the app_compose hash');
  let log: string | null;
  try {
    // The top-level log may leave RTMR3 payloads out; tcb_info's carries them.
    log = eventLogFailure(eventsOf(tcb.event_log ?? ev.event_log), q.rtmr, composeHash);
  } catch (err) {
    log = `unreadable: ${errorMessage(err)}`;
  }
  step('event log', log === null, log ?? 'replays to RTMR0-3; the compose-hash event is the app_compose hash');
  let gpus: number | null = null;
  if (ev.nvidia_payload !== undefined) {
    let payload: { nonce?: unknown; evidence_list?: unknown[] } = {};
    try {
      payload = (typeof ev.nvidia_payload === 'string' ? JSON.parse(ev.nvidia_payload) : ev.nvidia_payload) as typeof payload;
    } catch {
      // the nonce step fails below
    }
    gpus = Array.isArray(payload.evidence_list) ? payload.evidence_list.length : null;
    const ours = typeof payload.nonce === 'string' && payload.nonce.toLowerCase() === nonce.toLowerCase();
    const verdict = nras === undefined || nras === null ? null : nrasVerdict(nras);
    step('GPUs', ours && verdict === true, !ours ? 'the GPU evidence does not carry our nonce'
      : nras === undefined || nras === null ? 'NVIDIA NRAS did not answer' : verdict === null ? 'NVIDIA NRAS gave no verdict'
        : verdict ? `NVIDIA NRAS: ${gpus ?? '?'} GPU(s), overall result true` : 'NVIDIA NRAS: overall result false');
  }
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  return {
    tee, signingAddress: address, mrtd: q.mrtd, rtmr3: q.rtmr[3]!, composeHash,
    osImageHash: str(tcb.os_image_hash) ?? str(ev.info?.os_image_hash), appName: str(ev.info?.app_name), gpus,
  };
}

/** Checks a fetched report (and NRAS's answers) against `nonce`, as of `now`. Never throws. */
export function verifyAttestation(rec: AttestationRecording, now: number, source: Attestation['source']): Attestation {
  const steps: AttestationStep[] = [];
  const measurements: TeeMeasurements[] = [];
  const out = (why: string | null): Attestation => ({
    model: rec.model, at: rec.at, nonce: rec.nonce, source, verified: why === null, why, steps, measurements, notChecked: NOT_CHECKED,
  });
  const r = rec.report as { gateway_attestation?: TeeEvidence; model_attestations?: (TeeEvidence & { model_name?: unknown })[] } | null;
  if (r === null || typeof r !== 'object') return out('the attestation report is not an object');
  if (r.gateway_attestation === undefined) return out('the report has no gateway attestation');
  const models = Array.isArray(r.model_attestations) ? r.model_attestations : [];
  if (models.length === 0) return out(`NEAR AI publishes no model attestation for ${rec.model}`);
  const g = checkTee('gateway', r.gateway_attestation, rec.nonce, now, undefined, steps);
  if (g !== null) measurements.push(g);
  models.forEach((m, i) => {
    const tee = `model ${i + 1}`;
    if (m.model_name !== undefined && m.model_name !== rec.model) steps.push({ tee, step: 'model', ok: false, detail: `attests ${String(m.model_name)}, not ${rec.model}` });
    const x = checkTee(tee, m, rec.nonce, now, rec.nras[i], steps);
    if (x !== null) measurements.push(x);
  });
  const failed = steps.find((s) => !s.ok);
  return out(failed === undefined ? null : `${failed.tee} ${failed.step}: ${failed.detail}`);
}

/** Fetches the report with a fresh nonce, and asks NRAS about every model candidate's GPUs. Throws on no report. */
export async function fetchAttestation(options: { model?: string; fetch?: typeof fetch; now: number; nonce?: string } ): Promise<AttestationRecording> {
  const f = options.fetch ?? fetch;
  const model = options.model ?? NEAR_AI_MODEL;
  const nonce = options.nonce ?? randomBytes(32).toString('hex');
  const url = new URL(ATTESTATION_URL);
  for (const [k, v] of Object.entries({ model, provider: 'near', include_tls_fingerprint: 'false', signing_algo: 'ecdsa', nonce })) url.searchParams.set(k, v);
  const res = await f(url, { headers: { accept: 'application/json', 'x-no-aliasing': 'true' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const text = await res.text();
  if (!res.ok) throw new Error(`NEAR AI attestation answered HTTP ${res.status}`);
  let report: unknown;
  try {
    report = JSON.parse(text);
  } catch {
    throw new Error('NEAR AI attestation answered something that is not JSON');
  }
  const models = (report as { model_attestations?: { nvidia_payload?: unknown }[] }).model_attestations ?? [];
  const nras = await Promise.all((Array.isArray(models) ? models : []).map(async (m) => {
    if (m.nvidia_payload === undefined) return null;
    try {
      const body = typeof m.nvidia_payload === 'string' ? m.nvidia_payload : JSON.stringify(m.nvidia_payload);
      const a = await f(NRAS_URL, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
      return a.ok ? (await a.json()) as unknown : null;
    } catch {
      return null;
    }
  }));
  return { model, at: options.now, nonce, report, nras };
}

/** A recorded attestation (record-nearai --attestation): gzipped JSON, its quotes and certificates as they came. */
export function readAttestationRecording(path: string): AttestationRecording {
  const body = JSON.parse(gunzipSync(readFileSync(path)).toString('utf8')) as Partial<AttestationRecording>;
  if (typeof body.model !== 'string' || typeof body.at !== 'number' || typeof body.nonce !== 'string' || !Array.isArray(body.nras)) {
    throw new Error(`${path} is not an attestation recording`);
  }
  return { model: body.model, at: body.at, nonce: body.nonce, report: body.report, nras: body.nras };
}

export function writeAttestationRecording(path: string, rec: AttestationRecording, comment: string): void {
  writeFileSync(path, gzipSync(Buffer.from(`${JSON.stringify({ _comment: comment, ...rec })}\n`, 'utf8'), { level: 9 }));
}

/** One line for serve's start lines and the journal: the verdict, what was verified and what was not. */
export function attestationLine(a: Attestation | null, why?: string): string {
  if (a === null) return `NEAR AI attestation: not attested: ${why ?? 'not fetched yet'}`;
  const when = new Date(a.at).toISOString();
  const head = a.verified
    ? `NEAR AI attestation of ${a.model} (${a.source === 'live' ? 'fetched' : 'recorded'} ${when}): verified ${uniqueSteps(a)}`
    : `NEAR AI attestation of ${a.model} (${a.source === 'live' ? 'fetched' : 'recorded'} ${when}): FAILED: ${a.why}`;
  const tees = a.measurements.map((m) => `${m.tee} ${m.signingAddress} compose ${m.composeHash.slice(0, 16)}…${m.gpus === null ? '' : `, ${m.gpus} GPU(s)`}`).join('; ');
  return `${head}${tees === '' ? '' : `; ${tees}`}; not checked: ${a.notChecked.join(', ')}`;
}

function uniqueSteps(a: Attestation): string {
  return [...new Set(a.steps.map((s) => s.step))].join(', ');
}

/**
 * How a risk check shows the attestation: "attested" only for a live, verified report fetched within
 * ATTESTATION_VALID_MS; else "not attested: <why>".
 */
export function attestationLabel(a: Attestation | null, now: number, why?: string): string {
  if (a === null) return `not attested: ${why ?? 'no attestation fetched yet'}`;
  if (!a.verified) return `not attested: ${a.why}`;
  if (a.source === 'recorded') return `not attested: replay plays an attestation recorded ${new Date(a.at).toISOString().slice(0, 10)}, not a fresh one`;
  const age = now - a.at;
  if (age > ATTESTATION_VALID_MS) return `not attested: the last verified attestation is ${(age / 3_600_000).toFixed(0)} h old`;
  return 'attested';
}

/** serve's attestation: fetched at start and every ATTESTATION_EVERY_MS; `label()` for each check. */
export class Attestor {
  readonly model: string;
  readonly #fetch: typeof fetch | undefined;
  readonly #now: () => number;
  #last: Attestation | null = null;
  #why: string | undefined;
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: { model?: string; fetch?: typeof fetch; now: () => number; recorded?: AttestationRecording }) {
    this.model = options.model ?? NEAR_AI_MODEL;
    this.#fetch = options.fetch;
    this.#now = options.now;
    if (options.recorded !== undefined) this.#last = verifyAttestation(options.recorded, options.recorded.at, 'recorded');
  }

  get last(): Attestation | null {
    return this.#last;
  }

  /** Fetches and checks now; never throws. A failed fetch keeps the last result, and its age shows on the checks. */
  async refresh(): Promise<Attestation | null> {
    const now = this.#now();
    try {
      const rec = await fetchAttestation({ model: this.model, now, ...(this.#fetch === undefined ? {} : { fetch: this.#fetch }) });
      this.#last = verifyAttestation(rec, now, 'live');
      this.#why = undefined;
    } catch (err) {
      this.#why = `the attestation fetch failed: ${errorMessage(err)}`;
      if (this.#last !== null && this.#last.source === 'live') return this.#last;
      this.#last = null;
    }
    return this.#last;
  }

  line(): string {
    return this.#why !== undefined && this.#last === null ? attestationLine(null, this.#why)
      : `${attestationLine(this.#last)}${this.#why === undefined ? '' : ` (latest refresh: ${this.#why})`}`;
  }

  label(now = this.#now()): string {
    return attestationLabel(this.#last, now, this.#why);
  }

  /** Every ATTESTATION_EVERY_MS, then `onLine` with the result. */
  start(onLine: (line: string, a: Attestation | null) => void): void {
    if (this.#timer !== null) return;
    this.#timer = setInterval(() => {
      void this.refresh().then((a) => onLine(this.line(), a));
    }, ATTESTATION_EVERY_MS);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
  }
}
