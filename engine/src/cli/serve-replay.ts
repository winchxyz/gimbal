// Helpers of the serve CLI (its record and replay modes, its policy file, its scan log line), kept apart so they are
// tested without a server.

import { readFileSync } from 'node:fs';
import type { ContractPolicy } from '@gimbal/shared';
import { parseContractPolicy } from '../scanner/config.ts';
import { isEnterable } from '../scanner/price.ts';
import type { ScanResult } from '../scanner/scanner.ts';
import { errorMessage } from '../venues/recorder.ts';
import type { LineSink, RecordLine } from '../venues/recorder.ts';
import type { VenueMethod } from '../venues/venue.ts';

/**
 * The desk policy from a JSON file (get_desk's policy), checked: a file that does not parse or does not match
 * ContractPolicy throws, so the engine refuses to start rather than price windows against a policy it misread.
 */
export function loadPolicyFile(path: string): ContractPolicy {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    throw new Error(`policy file ${path}: ${errorMessage(err)}`);
  }
  try {
    return parseContractPolicy(JSON.parse(text));
  } catch (err) {
    throw new Error(`policy file ${path}: ${errorMessage(err)}`);
  }
}

/** One log line for a scan: counts, failed venues, and the best window the desk could enter now, if any. */
export function scanLine(n: number, r: ScanResult): string {
  const desk = r.windows.filter((w) => w.tradable);
  const enterable = r.windows.filter(isEnterable);
  const best = enterable[0];
  return `scan ${n}: ${r.windows.length} windows (${desk.length} on desk venues, ${enterable.length} enterable), failed [${r.scan.failed.join(', ')}], ${r.notes.ms} ms`
    + (best === undefined ? ', no enterable window' : `, best ${best.id} ${best.netAprPct.toFixed(2)} % net`)
    + `${r.notes.unpriced.length > 0 ? `, ${r.notes.unpriced.length} unpriced` : ''}, ${r.notes.historyReads} history reads`;
}

/**
 * A sink that writes a successful answer to the same call (venue, method, arguments) at most once per `minGapMs` of
 * its method; methods not listed are always written. Errors are always written, and so is the first success after
 * an error, so a replay shows an outage exactly as long as it lasted. Replay serves the latest answer at or before
 * its clock, so a thinned recording still answers every call; its numbers just move in steps of the gap.
 */
export class ThinningSink implements LineSink<RecordLine> {
  readonly #inner: LineSink<RecordLine>;
  readonly #gaps: Partial<Record<VenueMethod, number>>;
  readonly #last = new Map<string, { t: number; error: boolean }>();

  constructor(inner: LineSink<RecordLine>, gaps: Partial<Record<VenueMethod, number>>) {
    this.#inner = inner;
    this.#gaps = gaps;
  }

  write(line: RecordLine): void {
    const gap = this.#gaps[line.method] ?? 0;
    // A book is keyed by symbol alone in replay (depth only trims), so it is thinned the same way.
    const args = line.method === 'book' ? line.args.slice(0, 1) : line.args;
    const key = `${line.venue} ${line.method} ${JSON.stringify(args)}`;
    const error = line.error !== undefined;
    const last = this.#last.get(key);
    if (!error && gap > 0 && last !== undefined && !last.error && line.t - last.t < gap) return;
    this.#last.set(key, { t: line.t, error });
    this.#inner.write(line);
  }
}

/**
 * Where a replay starts: 1 s after the recorded first scan had its answers, that is the latest of each venue's first
 * successful funding, book and history answer, so the replay's first scan finds what the recorded one read.
 */
export function replayStart(lines: readonly RecordLine[]): number {
  const first = new Map<string, number>();
  for (const l of lines) {
    if (l.error !== undefined || (l.method !== 'funding' && l.method !== 'book' && l.method !== 'marketFundingHistory')) continue;
    const key = `${l.venue} ${l.method}`;
    const t = first.get(key);
    if (t === undefined || l.t < t) first.set(key, l.t);
  }
  if (first.size === 0) return lines.reduce((m, l) => Math.min(m, l.t), Infinity);
  return Math.max(...first.values()) + 1_000;
}
