// One sweep over a set of readers, all at once: what answered, what failed and why, how long it took. Used by
// `smoke watch`, `capture --venue watch` and the self-check test.

import type { ScanVenueId } from '@gimbal/shared';
import type { Clock, MarketFunding } from '../venue.ts';
import { systemClock } from '../venue.ts';
import { normalizeBase } from './symbols.ts';

/** Anything with an id and funding(): a WatchReader, or a tradable reader read as a reference. */
export interface FundingSource {
  readonly id: ScanVenueId;
  readonly kind?: 'dex' | 'cex';
  funding(): Promise<MarketFunding[]>;
}

export type VenueSweep =
  | { venue: ScanVenueId; kind: 'dex' | 'cex'; ok: true; markets: MarketFunding[]; ms: number }
  | { venue: ScanVenueId; kind: 'dex' | 'cex'; ok: false; error: string; ms: number };

export interface SweepResult {
  venues: VenueSweep[];          // in the readers' order
  ms: number;                    // wall time of the whole sweep
}

/** Reads every source in parallel; a failure is reported with its message, never as an empty list. */
export async function sweep(sources: readonly FundingSource[], clock: Clock = systemClock): Promise<SweepResult> {
  const started = clock.now();
  const venues = await Promise.all(sources.map(async (s): Promise<VenueSweep> => {
    const t0 = clock.now();
    const kind = s.kind ?? 'dex';
    try {
      const markets = await s.funding();
      return { venue: s.id, kind, ok: true, markets, ms: clock.now() - t0 };
    } catch (err) {
      return { venue: s.id, kind, ok: false, error: err instanceof Error ? err.message : String(err), ms: clock.now() - t0 };
    }
  }));
  return { venues, ms: clock.now() - started };
}

/** The cross-venue key of a market: `base` when the reader set it, else the normalised symbol. */
export function baseOf(f: MarketFunding): string {
  return f.base ?? normalizeBase(f.symbol).base;
}

/** Markets of the venues that answered, by venue. */
export function answered(result: SweepResult): Map<ScanVenueId, MarketFunding[]> {
  const out = new Map<ScanVenueId, MarketFunding[]>();
  for (const v of result.venues) if (v.ok) out.set(v.venue, v.markets);
  return out;
}

/** Bases listed on two venues or more. */
export function sharedBases(byVenue: ReadonlyMap<ScanVenueId, readonly MarketFunding[]>): number {
  const count = new Map<string, number>();
  for (const markets of byVenue.values()) {
    for (const b of new Set(markets.map(baseOf))) count.set(b, (count.get(b) ?? 0) + 1);
  }
  return [...count.values()].filter((n) => n >= 2).length;
}

/** The sweep as printable lines: one per venue, then the totals. */
export function sweepReport(result: SweepResult): string[] {
  const lines: string[] = [];
  const width = Math.max(...result.venues.map((v) => v.venue.length));
  for (const v of result.venues) {
    const head = `${v.venue.padEnd(width)}  ${v.kind}  ${String(v.ms).padStart(5)} ms  `;
    lines.push(v.ok ? `${head}${String(v.markets.length).padStart(4)} markets` : `${head}FAILED ${v.error}`);
  }
  const ok = result.venues.filter((v) => v.ok);
  const markets = ok.reduce((n, v) => n + (v.ok ? v.markets.length : 0), 0);
  const failed = result.venues.filter((v) => !v.ok).map((v) => v.venue);
  lines.push(`venues answered ${ok.length}/${result.venues.length}${failed.length > 0 ? ` (failed: ${failed.join(', ')})` : ''}`);
  lines.push(`markets ${markets}, symbols on 2+ venues ${sharedBases(answered(result))}, sweep ${(result.ms / 1000).toFixed(1)} s`);
  return lines;
}
