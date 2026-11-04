// Venue health for the `health` event (HealthMap): each desk venue, NEAR Intents (1Click) and NEAR, as ok / slow / down.
//
// A venue is the worst of what the engine has seen of it:
//   - down: the last scan could not read it, or the risk engine's last account read failed (API error, timeout);
//   - slow: the account read answered but took over SLOW_READ_MS, or withdrawals are paused there (it still trades,
//     but it cannot be a rescue source: E9 reads that from `detail()`, since HealthMap has no word for it);
//   - ok otherwise.
// Paused withdrawals: none of the readers can see them, no venue API the engine reads states it. What sets it is the
// withdraw step itself (E9): a venue refusing a withdraw because withdrawals are paused calls withdrawals(venue,
// reason), and a withdraw that goes through clears it with withdrawals(venue, null). With no news a report expires
// after WITHDRAWALS_PAUSED_TTL_MS, so one refusal does not mark a venue for good.
// 1Click is probed (GET /v0/tokens, public, no key): an error or a non-2xx is down, an answer over SLOW_READ_MS slow.
// NEAR is the worse of the contract client's own health (the operator key's budget, slow MPC signatures) and the
// desk view's (get_desk: slow when its latest read failed or is late, down when it was never read or is stale).
// The pair trader's start (serve-pair.ts, review S1) adds its own word for Hyperliquid, Phoenix and NEAR until its
// start is confirmed: down when a read it needs failed, slow when the Phoenix snapshot lags the chain. With
// GIMBAL_ORDERLY_PAIRS=1 it adds Orderly's too (an Orderly pair's start reads); the session itself being down or
// unseeded shows as the risk engine's Orderly account read failing (readFailed).

import type { HealthMap, ScanStatus, VenueId } from '@gimbal/shared';
import type { NearHealth } from '../contract/budget.ts';
import { errorMessage } from '../venues/recorder.ts';
import { DESK_VENUE_IDS } from '../venues/venue.ts';

export type HealthKey = keyof HealthMap;
export type HealthStatus = HealthMap[HealthKey];

/** An account read slower than this marks the venue slow (venue reads usually answer in well under a second). */
export const SLOW_READ_MS = 5_000;
export const ONE_CLICK_URL = 'https://1click.chaindefuser.com/v0';
/** A "withdrawals paused" report counts this long, unless reported again or cleared. */
export const WITHDRAWALS_PAUSED_TTL_MS = 15 * 60_000;

/** What the tracker knows of one venue beyond its HealthMap word. */
export interface VenueDetail {
  status: HealthStatus;
  scanFailed: boolean;
  readError: string | null;
  readMs: number | null;
  withdrawalsPaused: string | null;   // the venue's words, while the report counts
  /** Why the pair trader's start could not read this venue (null: it could, or it does not read it). */
  start: string | null;
}

export class VenueHealth {
  readonly #venues = new Map<VenueId, VenueDetail>();
  readonly #pausedAt = new Map<VenueId, number>();
  readonly #now: () => number;
  #intents: HealthStatus = 'ok';
  #intentsDetail: string | null = null;
  #near: NearHealth = 'ok';
  #deskView: HealthStatus = 'ok';
  #deskViewDetail: string | null = null;
  #last: HealthMap | null = null;
  readonly #start = new Map<HealthKey, { status: HealthStatus; detail: string | null }>();

  constructor(options: { now?: () => number } = {}) {
    this.#now = options.now ?? Date.now;
    for (const v of DESK_VENUE_IDS) this.#venues.set(v, { status: 'ok', scanFailed: false, readError: null, readMs: null, withdrawalsPaused: null, start: null });
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

  /** An account read (or any venue call) that failed. */
  readFailed(venue: VenueId, err: unknown): void {
    const d = this.#venues.get(venue)!;
    d.readError = errorMessage(err);
    d.readMs = null;
  }

  /**
   * What the withdraw step learnt (see the header): the venue's words when it refused a withdraw because withdrawals
   * are paused; null after a withdraw went through.
   */
  withdrawals(venue: VenueId, paused: string | null): void {
    this.#venues.get(venue)!.withdrawalsPaused = paused;
    if (paused === null) this.#pausedAt.delete(venue);
    else this.#pausedAt.set(venue, this.#now());
  }

  intents(status: HealthStatus, detail: string | null = null): void {
    this.#intents = status;
    this.#intentsDetail = detail;
  }

  near(status: NearHealth): void {
    this.#near = status;
  }

  /** The pair trader's start reads (serve-pair.ts): `ok` once its start is confirmed. */
  pairStart(key: 'hyperliquid' | 'phoenix' | 'near' | 'orderly', status: HealthStatus, detail: string | null = null): void {
    if (status === 'ok') this.#start.delete(key);
    else this.#start.set(key, { status, detail });
    const d = this.#venues.get(key as VenueId);
    if (d !== undefined) d.start = status === 'ok' ? null : detail ?? status;
  }

  /** The desk view's state (the risk engine sets it from its source's get_desk reads), and why. */
  deskView(status: HealthStatus, detail: string | null = null): void {
    this.#deskView = status;
    this.#deskViewDetail = detail;
  }

  /** Why NEAR is not ok, when the desk view says so (null otherwise). */
  get nearDetail(): string | null {
    return this.#deskView === 'ok' ? this.#start.get('near')?.detail ?? null : this.#deskViewDetail;
  }

  detail(venue: VenueId): VenueDetail {
    this.#expire();
    const d = this.#venues.get(venue)!;
    return { ...d, status: worse(this.#status(d), this.#start.get(venue)?.status ?? 'ok') };
  }

  get intentsDetail(): string | null {
    return this.#intentsDetail;
  }

  map(): HealthMap {
    this.#expire();
    const map = { intents: this.#intents, near: worse(worse(this.#near, this.#deskView), this.#start.get('near')?.status ?? 'ok') } as HealthMap;
    for (const [v, d] of this.#venues) map[v] = worse(this.#status(d), this.#start.get(v)?.status ?? 'ok');
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

  #expire(): void {
    for (const [venue, at] of this.#pausedAt) {
      if (this.#now() - at < WITHDRAWALS_PAUSED_TTL_MS) continue;
      this.#pausedAt.delete(venue);
      this.#venues.get(venue)!.withdrawalsPaused = null;
    }
  }

  #status(d: VenueDetail): HealthStatus {
    if (d.scanFailed || d.readError !== null) return 'down';
    if ((d.readMs !== null && d.readMs > SLOW_READ_MS) || d.withdrawalsPaused !== null) return 'slow';
    return 'ok';
  }
}

const RANK: Record<HealthStatus, number> = { ok: 0, slow: 1, down: 2 };

function worse(a: HealthStatus, b: HealthStatus): HealthStatus {
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
