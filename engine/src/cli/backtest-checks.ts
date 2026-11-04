// Read-only backtest of the strategy loop's hourly-check counts (LOOP_RULES.enterAfterChecks and exitAfterChecks):
// the real scanner and decide() stepped hour by hour over public funding history, for every pair of counts, and what
// each pair nets in USD. Public reads only, no keys, nothing signed; the history is cached so a rerun reads nothing.
//   npm run backtest:checks -- [--cache <dir>] [--no-fetch] [--leg-usd 12,1000] [--scope live,all] [--enter 1,2,3,4]
//                              [--exit 1,2,3,4] [--days <n>] [--json <file>]
// --cache     where the history and today's snapshot are kept (default engine/.cache/backtest-checks, gitignored)
// --no-fetch  fail instead of reading a venue when the cache is incomplete
// --scope     live: long Phoenix / short Hyperliquid only, the direction serve opens; all: every direction on
//             Hyperliquid, Phoenix and Orderly
// --days      only the last n days of checks (default every hour the cache covers)
// --json      also write every result, trades included, to this file
// See docs/backtest-checks.md for the method and the caveats.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { ContractPolicy, StrategyConfig, VenueId } from '@gimbal/shared';
import { loadData } from '../backtest/checks-data.ts';
import type { BacktestData } from '../backtest/checks-data.ts';
import { day, money, periodLines, tableLines, tradeLines, valueMissed } from '../backtest/checks-report.ts';
import type { RunSummary } from '../backtest/checks-report.ts';
import { HOUR_MS, Realized, firstCheckHour, lastCheckHour, simulate } from '../backtest/checks-sim.ts';
import type { Scope, SimResult } from '../backtest/checks-sim.ts';
import { DEFAULT_STRATEGY } from '../scanner/config.ts';
import { errorMessage } from '../venues/recorder.ts';
import { loadPolicyFile } from './serve-replay.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** The live desk's engine rules (legUsd varies by run). */
export const LIVE_STRATEGY: StrategyConfig = {
  ...DEFAULT_STRATEGY, auto: true, minNetAprPct: 5, legUsd: 12, maxLeverage: 3, stopDrawdownPct: 10, rotate: { minGainPts: 3, forHours: 4 },
};

const VENUES: Record<Scope, VenueId[]> = { live: ['hyperliquid', 'phoenix'], all: ['hyperliquid', 'phoenix', 'orderly'] };

const ints = (s: string) => s.split(',').map((x) => {
  const n = Number(x);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`not a positive number: ${x}`);
  return n;
});

/** The policy for a run: the mainnet desk's, its notional cap raised to fit a larger leg (the 12 USD run keeps 20). */
function policyFor(base: ContractPolicy, legUsd: number): ContractPolicy {
  return { ...base, max_notional_usd: Math.max(base.max_notional_usd, Math.ceil(legUsd * 1.05)) };
}

export async function run(data: BacktestData, policy: ContractPolicy, o: {
  scope: Scope; legUsd: number; enter: readonly number[]; exit: readonly number[]; days: number | null; log: (s: string) => void;
}): Promise<RunSummary> {
  const venues = VENUES[o.scope];
  const end = lastCheckHour(data, venues);
  const first = firstCheckHour(data, venues);
  const start = o.days === null ? first : Math.max(first, end - o.days * 24 * HOUR_MS);
  const realized = new Realized(data);
  const results: SimResult[] = [];
  for (const e of o.enter) {
    for (const x of o.exit) {
      const t0 = Date.now();
      const r = await simulate(data, {
        enterAfterChecks: e, exitAfterChecks: x, strategy: { ...LIVE_STRATEGY, legUsd: o.legUsd }, policy: policyFor(policy, o.legUsd),
        scope: o.scope, venues, start, end,
      }, realized);
      results.push(r);
      o.log(`${o.scope} ${o.legUsd} USD enter ${e} exit ${x}: ${r.entries} entries, ${r.rotations} rotations, net ${money(r.netUsd, 3)} USD (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
    }
  }
  return { scope: o.scope, legUsd: o.legUsd, start, end, results, missedNetUsd: valueMissed(results) };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      cache: { type: 'string' }, 'no-fetch': { type: 'boolean', default: false }, 'leg-usd': { type: 'string', default: '12,1000' },
      scope: { type: 'string', default: 'live,all' }, enter: { type: 'string', default: '1,2,3,4' }, exit: { type: 'string', default: '1,2,3,4' },
      days: { type: 'string' }, json: { type: 'string' },
    },
  });
  const scopes = values.scope.split(',').map((s) => {
    if (s !== 'live' && s !== 'all') throw new Error(`--scope: live or all, got ${s}`);
    return s as Scope;
  });
  const cache = values.cache ?? join(ROOT, 'engine/.cache/backtest-checks');
  const policy = loadPolicyFile(join(ROOT, 'tools/mainnet-final-policy.json'));
  const log = (s: string) => console.error(s);
  const data = await loadData(cache, policy, { allowFetch: !values['no-fetch'], log });
  const out: RunSummary[] = [];
  console.log('# Entry/exit checks backtest\n');
  console.log('| venue | symbol | first print | last print | days |\n|---|---|---|---|---|');
  for (const h of data.history) {
    const a = h.points[0]?.time;
    const b = h.points.at(-1)?.time;
    console.log(`| ${h.venue} | ${h.symbol} | ${a === undefined ? '-' : day(a)} | ${b === undefined ? '-' : day(b)} | ${a === undefined || b === undefined ? 0 : ((b - a) / 86_400_000).toFixed(1)} |`);
  }
  for (const scope of scopes) {
    for (const legUsd of ints(values['leg-usd'])) {
      const s = await run(data, policy, { scope, legUsd, enter: ints(values.enter), exit: ints(values.exit), days: values.days === undefined ? null : Number(values.days), log });
      out.push(s);
      console.log(`\n## Scope ${scope}, ${legUsd} USD a leg: checks ${day(s.start)} to ${day(s.end)} (${((s.end - s.start) / 86_400_000).toFixed(1)} days)\n`);
      for (const l of tableLines(s)) console.log(l);
      console.log('\nNet USD by when the trade was entered (the checks in three equal spans):\n');
      for (const l of periodLines(s, 3)) console.log(l);
      const best = [...s.results].sort((a, b) => b.netUsd - a.netUsd)[0]!;
      const current = s.results.find((r) => r.enterAfterChecks === 3 && r.exitAfterChecks === 3);
      console.log(`\nTop 5 trades, best setting (enter ${best.enterAfterChecks}, exit ${best.exitAfterChecks}):\n`);
      for (const l of tradeLines(best.trades, 5, legUsd)) console.log(l);
      if (current !== undefined) {
        console.log('\nTop 5 trades, current setting (enter 3, exit 3):\n');
        for (const l of tradeLines(current.trades, 5, legUsd)) console.log(l);
      }
    }
  }
  if (values.json !== undefined) writeFileSync(values.json, JSON.stringify(out, null, 1));
}

main().catch((err: unknown) => {
  console.error(`backtest-checks: ${errorMessage(err)}`);
  process.exit(1);
});
