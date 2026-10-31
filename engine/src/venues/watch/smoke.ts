// `npm run smoke -w engine -- watch`: one live sweep over every watch venue (plus Hyperliquid's main dex as the
// self-check's reference), then the cross-venue self-check. Public keyless reads, nothing is written.

import { HyperliquidReader } from '../hyperliquid.ts';
import { watchReaders } from './index.ts';
import { selfCheckReport } from './self-check.ts';
import { answered, sweep, sweepReport } from './sweep.ts';

/**
 * Prints the sweep and the self-check; false when a venue failed. Live self-check findings are printed as
 * warnings: the test over the recorded sweep is what gates a unit change, live markets drift around the limits.
 */
export async function smokeWatch(log: (line: string) => void = console.log): Promise<boolean> {
  const result = await sweep([new HyperliquidReader(), ...watchReaders()]);
  log('watch venues, mainnet (hyperliquid = the main dex, read as the reference)');
  for (const line of sweepReport(result)) log(line);
  log('');
  const { lines, problems } = selfCheckReport(answered(result));
  for (const line of lines) log(line);
  for (const p of problems) log(`WARNING ${p}`);
  if (problems.length === 0) log('self-check: no venue looks slipped or flipped');
  return result.venues.every((v) => v.ok);
}
