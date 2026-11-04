// The backtest's tables: one row per pair of counts, and a run's best trades. Markdown, as docs/backtest-checks.md
// shows them.

import type { Scope, SimResult, Trade } from './checks-sim.ts';

export const day = (t: number) => new Date(t).toISOString().slice(0, 13).replace('T', ' ') + 'h';
export const money = (n: number, d = 2) => `${n < 0 ? '-' : ''}${Math.abs(n).toFixed(d)}`;

export interface RunSummary {
  scope: Scope;
  legUsd: number;
  start: number;
  end: number;
  results: SimResult[];
  /** Per (enter, exit): net USD of the N=1 run's trades that started on a streak this run missed. */
  missedNetUsd: Record<string, { matched: number; unmatched: number; netUsd: number }>;
}

/** Missed streaks valued by what the 1-check entry (same exit count) made on trades entered on them. */
export function valueMissed(results: readonly SimResult[]): RunSummary['missedNetUsd'] {
  const out: RunSummary['missedNetUsd'] = {};
  for (const r of results) {
    const base = results.find((x) => x.enterAfterChecks === 1 && x.exitAfterChecks === r.exitAfterChecks);
    let matched = 0;
    let unmatched = 0;
    let netUsd = 0;
    for (const m of r.missed) {
      const t = base?.trades.find((x) => x.how === 'enter' && x.windowId === m.windowId && x.enteredAt === m.startedAt);
      if (t === undefined) {
        unmatched++;
        continue;
      }
      matched++;
      netUsd += t.netUsd;
    }
    out[`${r.enterAfterChecks},${r.exitAfterChecks}`] = { matched, unmatched, netUsd };
  }
  return out;
}

export function tableLines(s: RunSummary): string[] {
  const head = '| enter | exit | entries | exits | rotations | hours held | gross USD | costs USD | net USD | net / entry | missed (valued at N=1) | waited-hours funding USD | late-exit hours | late-exit funding USD | bad runs held through |';
  const sep = '|' + head.slice(1).replace(/[^|]/g, '-');
  const lines = [head, sep];
  const d = s.legUsd >= 100 ? 2 : 3;
  for (const r of s.results) {
    const opened = r.entries + r.rotations;
    const waited = r.trades.reduce((a, t) => a + t.waitedFundingUsd, 0);
    const late = r.trades.filter((t) => t.badHours > 0);
    const lateHours = late.reduce((a, t) => a + t.badHours, 0);
    const lateUsd = late.reduce((a, t) => a + t.badFundingUsd, 0);
    const m = s.missedNetUsd[`${r.enterAfterChecks},${r.exitAfterChecks}`]!;
    const missed = r.missed.length === 0 ? '0' : `${r.missed.length} (${m.matched} valued: ${money(m.netUsd, d)})`;
    lines.push(`| ${r.enterAfterChecks} | ${r.exitAfterChecks} | ${r.entries} | ${r.exits} | ${r.rotations} | ${r.hoursHeld} | ${money(r.grossUsd, d)} | `
      + `${money(r.costUsd, d)} | **${money(r.netUsd, d)}** | ${opened === 0 ? '-' : money(r.netUsd / opened, d)} | ${missed} | ${money(waited, d)} | ${lateHours} | ${money(lateUsd, d)} | ${r.recovered} |`);
  }
  return lines;
}

export function tradeLines(trades: readonly Trade[], n: number, legUsd: number): string[] {
  const d = legUsd >= 100 ? 2 : 3;
  const top = [...trades].sort((a, b) => b.netUsd - a.netUsd).slice(0, n);
  const lines = ['| window | how | entered | exited | hours | funding USD | cost USD | net USD | exit |', '|---|---|---|---|---|---|---|---|---|'];
  for (const t of top) {
    lines.push(`| ${t.windowId} | ${t.how} | ${day(t.enteredAt)} | ${t.exitedAt === null ? 'held at end' : day(t.exitedAt)} | ${t.hours} | ${money(t.fundingUsd, d)} | `
      + `${money(t.costUsd, d)} | ${money(t.netUsd, d)} | ${t.exitReason.replace(/\|/g, '/')} |`);
  }
  return lines;
}


/**
 * Net USD by the period a trade was entered in, the checks cut in `parts` equal spans: whether a setting's lead holds
 * across the sample or comes from one stretch of it.
 */
export function periodLines(s: RunSummary, parts: number): string[] {
  const span = (s.end - s.start) / parts;
  const edges = Array.from({ length: parts }, (_, i) => s.start + i * span);
  const d = s.legUsd >= 100 ? 2 : 3;
  const head = `| enter | exit | ${edges.map((e) => `from ${day(e).slice(0, 10)}`).join(' | ')} |`;
  const lines = [head, '|' + head.slice(1).replace(/[^|]/g, '-')];
  for (const r of s.results) {
    const nets = edges.map((e, i) => r.trades.filter((t) => t.enteredAt >= e && (i === parts - 1 || t.enteredAt < e + span)).reduce((a, t) => a + t.netUsd, 0));
    lines.push(`| ${r.enterAfterChecks} | ${r.exitAfterChecks} | ${nets.map((n) => money(n, d)).join(' | ')} |`);
  }
  return lines;
}
