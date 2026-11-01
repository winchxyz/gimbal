// Venue health for the `health` event (HealthMap): each desk venue, NEAR Intents (1Click) and NEAR, as ok / slow / down.
//
// A venue is the worst of what the engine has seen of it:
//   - down: the last scan could not read it, or the risk engine's last account read failed (API error, timeout);
//   - slow: the account read answered but took over SLOW_READ_MS, or the venue said withdrawals are paused (it still
//     trades, but it cannot be a rescue source: E9 reads that from `detail()`, since HealthMap has no word for it);
//   - ok otherwise.
// 1Click is probed (GET /v0/tokens, public, no key): an error or a non-2xx is down, an answer over SLOW_READ_MS slow.
// NEAR comes from the contract client's own health (the operator key's budget, slow MPC signatures).

import type { HealthMap, ScanStatus, VenueId } from '@gimbal/shared';
import type { NearHealth } from '../contract/budget.ts';
import { errorMessage } from '../venues/recorder.ts';
import { DESK_VENUE_IDS } from '../venues/venue.ts';

export type HealthKey = keyof HealthMap;
export type HealthStatus = HealthMap[HealthKey];

/** An account read slower than this marks the venue slow (venue reads usually answer in well under a second). */
export const SLOW_READ_MS = 5_000;
export const ONE_CLICK_URL = 'https://1click.chaindefuser.com/v0';

/** What the tracker knows of one venue beyond its HealthMap word. */
export interface VenueDetail {
  status: HealthStatus;
  scanFailed: boolean;
  readError: string | null;
  readMs: number | null;
  withdrawalsPaused: string | null;   // the venue's words, when it said so
}

/** A venue error that says withdrawals are paused (or disabled, halted, suspended). */
export function saysWithdrawalsPaused(message: string): boolean {
  return /withdraw\w*\b[^.]{0,40}\b(paused|disabled|halted|suspended|unavailable)|(paused|disabled|halted|suspended)\b[^.]{0,40}\bwithdraw/i.test(message);
}

const RANK: Record<HealthStatus, number> = { ok: 0, slow: 1, down: 2 };

export class VenueHealth {
  readonly #venues = new Map<VenueId, VenueDetail>();
  #intents: HealthStatus = 'ok';
  #intentsDetail: string | null = null;
  #near: NearHealth = 'ok';
  #last: HealthMap | null = null;

  constructor() {
    for (const v of DESK_VENUE_IDS) this.#venues.set(v, { status: 'ok', scanFailed: false, readError: null, readMs: null, withdrawalsPaused: null });
  }

  /** The scanner's view: the desk venues its last scan could not read. */
  scan(scan: ScanStatus): void {
    const failed = new Set(scan.failed);
    for (const [v, d] of this.#venues) d.scanFailed = failed.has(v);
  }

  /** An account read that answered, and how long it took. */
  readOk(venue: VenueId, ms: number): void {
    const d = this.#venues.get(venue)!;
    d.readError = null;
    d.readMs = ms;
  }

  /** An account read (or any venue call) that failed; a message saying withdrawals are paused also sets that. */
  readFailed(venue: VenueId, err: unknown): void {
    const d = this.#venues.get(venue)!;
    const message = errorMessage(err);
    if (saysWithdrawalsPaused(message)) {
      d.withdrawalsPaused = message;
      return;                             // the venue answered: it is up, its withdrawals are not
    }
    d.readError = message;
    d.readMs = null;
  }

  /** What a venue said about withdrawals; null clears it. */
  withdrawals(venue: VenueId, paused: string | null): void {
    this.#venues.get(venue)!.withdrawalsPaused = paused;
  }

  intents(status: HealthStatus, detail: string | null = null): void {
    this.#intents = status;
    this.#intentsDetail = detail;
  }

  near(status: NearHealth): void {
    this.#near = status;
  }

  detail(venue: VenueId): VenueDetail {
    const d = this.#venues.get(venue)!;
    return { ...d, status: this.#status(d) };
  }

  get intentsDetail(): string | null {
    return this.#intentsDetail;
  }

  map(): HealthMap {
    const map = { intents: this.#intents, near: this.#near } as HealthMap;
    for (const [v, d] of this.#venues) map[v] = this.#status(d);
    return map;
  }

  /** The map when it differs from the last one this returned, else null (publish only changes). */
  changed(): HealthMap | null {
    const next = this.map();
    const last = this.#last;
    if (last !== null && (Object.keys(next) as HealthKey[]).every((k) => last[k] === next[k])) return null;
    this.#last = next;
    return next;
  }

  #status(d: VenueDetail): HealthStatus {
    if (d.scanFailed || d.readError !== null) return 'down';
    if ((d.readMs !== null && d.readMs > SLOW_READ_MS) || d.withdrawalsPaused !== null) return 'slow';
    return 'ok';
  }
}

export function worse(a: HealthStatus, b: HealthStatus): HealthStatus {
  return RANK[a] >= RANK[b] ? a : b;
}

/**
 * One 1Click probe: GET /tokens. Down on an error, a non-2xx or no answer within `timeoutMs`; slow over SLOW_READ_MS.
 */
export async function probeIntents(options: { fetch?: typeof fetch; baseUrl?: string; timeoutMs?: number; now?: () => number } = {}): Promise<{ status: HealthStatus; detail: string }> {
  const f = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const started = now();
  try {
    const res = await f(`${options.baseUrl ?? ONE_CLICK_URL}/tokens`, { signal: AbortSignal.timeout(options.timeoutMs ?? 15_000) });
    const ms = now() - started;
    if (!res.ok) return { status: 'down', detail: `1Click /tokens answered ${res.status}` };
    await res.body?.cancel();
    return ms > SLOW_READ_MS ? { status: 'slow', detail: `1Click /tokens took ${ms} ms` } : { status: 'ok', detail: `1Click /tokens in ${ms} ms` };
  } catch (err) {
    return { status: 'down', detail: `1Click /tokens: ${errorMessage(err)}` };
  }
}
