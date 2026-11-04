// GIMBAL_LOG_EGRESS=1: serve logs the public IPv4 addresses its outbound traffic leaves from, once at start and once
// an hour, as one line `egress ipv4: a, b, c`. A host with several static egress IPs (Railway's HA static IPs balance
// over three) shows a different one per connection, so each check asks the echo service three times, a few seconds
// apart, and logs the distinct answers. The owner needs every one of them in the desk's Orderly IP list: a list that
// leaves one out locks the engine out of Orderly on the connections that leave from it.
//
// Read-only and never fatal: one GET per lookup, 5 s each, no retry loop; a failed lookup is named on the same line.
// Unset (anything but 1): no request and no line. Independent of GIMBAL_ORDERLY_PAIRS.

import { canonicalIp } from '../setup/public-ip.ts';
import { errorMessage } from '../venues/recorder.ts';

export const LOG_EGRESS_ENV = 'GIMBAL_LOG_EGRESS';
/** Answers with the caller's IPv4 address as plain text (IPv4 only, unlike api64.ipify.org). */
export const EGRESS_URL = 'https://api.ipify.org';
export const EGRESS_LOOKUPS = 3;
export const EGRESS_GAP_MS = 3_000;
export const EGRESS_TIMEOUT_MS = 5_000;
export const EGRESS_EVERY_MS = 3_600_000;

export function logEgressOn(env: (name: string) => string | undefined): boolean {
  return env(LOG_EGRESS_ENV) === '1';
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

export interface EgressOptions {
  fetch?: typeof fetch;
  /** Waits between lookups; tests pass one that resolves at once. */
  sleep?: (ms: number) => Promise<void>;
  url?: string;
  lookups?: number;
  gapMs?: number;
  timeoutMs?: number;
}

const sleepUnref = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref());

/** One check: `lookups` GETs `gapMs` apart, the distinct IPv4 answers in the order seen. Never rejects. */
export async function egressLine(o: EgressOptions = {}): Promise<string> {
  const fetchImpl = o.fetch ?? fetch;
  const sleep = o.sleep ?? sleepUnref;
  const lookups = o.lookups ?? EGRESS_LOOKUPS;
  const url = o.url ?? EGRESS_URL;
  const timeoutMs = o.timeoutMs ?? EGRESS_TIMEOUT_MS;
  const ips: string[] = [];
  const failed: string[] = [];
  for (let i = 0; i < lookups; i++) {
    if (i > 0) await sleep(o.gapMs ?? EGRESS_GAP_MS);
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
      const text = (await res.text()).trim();
      const ip = res.ok && IPV4.test(text) ? canonicalIp(text) : null;
      if (ip === null) failed.push(res.ok ? `not an IPv4 address (${text.slice(0, 40)})` : `HTTP ${res.status}`);
      else if (!ips.includes(ip)) ips.push(ip);
    } catch (err) {
      failed.push(errorMessage(err));
    }
  }
  const reasons = [...new Set(failed)].join('; ');
  if (ips.length === 0) return `egress ipv4: unknown (${failed.length} of ${lookups} lookups failed: ${reasons})`;
  const tail = failed.length === 0 ? '' : ` (${failed.length} of ${lookups} lookups failed: ${reasons})`;
  return `egress ipv4: ${ips.join(', ')}${tail}`;
}

export interface EgressLog {
  /** The check in flight, if any (tests wait for it). */
  readonly current: Promise<void> | null;
  stop(): void;
}

/** Null when the flag is off: nothing asked, nothing logged. Otherwise one check now and one every hour. */
export function startEgressLog(input: EgressOptions & {
  env: (name: string) => string | undefined;
  log: (line: string) => void;
  everyMs?: number;
}): EgressLog | null {
  if (!logEgressOn(input.env)) return null;
  let current: Promise<void> | null = null;
  const check = () => {
    if (current !== null) return; // the previous check is still asking: never two at once
    current = egressLine(input)
      .then((line) => input.log(line))
      .catch((err: unknown) => input.log(`egress ipv4: not logged (${errorMessage(err)})`))
      .finally(() => { current = null; });
  };
  check();
  const timer = setInterval(check, input.everyMs ?? EGRESS_EVERY_MS);
  timer.unref();
  return {
    get current() { return current; },
    stop: () => clearInterval(timer),
  };
}
