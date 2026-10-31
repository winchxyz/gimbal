#!/usr/bin/env node
// Builds the canary policy from live mainnet data and checks tools/mainnet-canary-policy.json against it.
//
//   node tools/mainnet/policy.mjs [--write]
//
// hl_assets: BTC, ETH, SOL, DOGE, LTC (the contract's oracle assets) with Hyperliquid's index and szDecimals;
// phoenix_markets: those of them Phoenix lists (orderbook, base_lot_e8, tick_e8 from perp-api.phoenix.trade);
// orderly_symbols: PERP_<X>_USDC that Orderly lists; the canary's limits (20 USD per leg, 100 bps band, 900 s oracle
// age, 20 USD rescue cap per hour). Default: print the policy and compare it with the file (exit 1 when they
// differ). --write: write the file. Reads only public venue APIs; nothing is signed.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { UsageError, isMain, parseFlags, run } from './cli.mjs';
import { ROOT } from './near.mjs';
import { buildPolicy, formatPolicy, livePolicyProblems, policyShapeProblems, readLive } from './venues.mjs';

export const CANARY_POLICY_FILE = join(ROOT, 'tools', 'mainnet-canary-policy.json');
const USAGE = 'usage: node tools/mainnet/policy.mjs [--write]';

/** Field-by-field differences between two policies, as lines. */
export function policyDiff(want, got) {
  const out = [];
  for (const k of new Set([...Object.keys(want), ...Object.keys(got)])) {
    const a = JSON.stringify(want[k]);
    const b = JSON.stringify(got[k]);
    if (a !== b) out.push(`  ${k}: live ${a ?? 'missing'}\n  ${' '.repeat(k.length)}  file ${b ?? 'missing'}`);
  }
  return out;
}

async function main() {
  const { positional, values } = parseFlags(process.argv.slice(2), { '--write': 'switch' });
  if (positional.length > 0) throw new UsageError(`unexpected argument ${positional[0]}`);
  const live = await readLive();
  const built = buildPolicy(live);
  const shape = policyShapeProblems(built);
  if (shape.length > 0) throw new Error(`the policy built from live data is not valid:\n  ${shape.join('\n  ')}`);
  console.log('canary policy from live mainnet data (Hyperliquid meta, Phoenix markets, Orderly public/info):');
  console.log(formatPolicy(built).trimEnd());
  const missingPhoenix = built.hl_assets.map((a) => a.symbol).filter((s) => !built.phoenix_markets.some((m) => m.symbol === s));
  const missingOrderly = built.hl_assets.map((a) => a.symbol).filter((s) => !built.orderly_symbols.includes(`PERP_${s}_USDC`));
  console.log(`Phoenix lists ${built.phoenix_markets.length} of ${built.hl_assets.length}${missingPhoenix.length ? ` (not ${missingPhoenix.join(', ')})` : ''}; `
    + `Orderly lists ${built.orderly_symbols.length} of ${built.hl_assets.length}${missingOrderly.length ? ` (not ${missingOrderly.join(', ')})` : ''}`);

  if (values['--write']) {
    writeFileSync(CANARY_POLICY_FILE, formatPolicy(built));
    console.log(`\nwrote tools/mainnet-canary-policy.json`);
    return;
  }
  if (!existsSync(CANARY_POLICY_FILE)) throw new Error('tools/mainnet-canary-policy.json does not exist: run with --write');
  const file = JSON.parse(readFileSync(CANARY_POLICY_FILE, 'utf8'));
  const problems = [...policyShapeProblems(file), ...livePolicyProblems(file, live)];
  const diff = policyDiff(built, file);
  if (problems.length > 0 || diff.length > 0) {
    throw new Error(`tools/mainnet-canary-policy.json does not match live data:\n${[...problems.map((p) => `  ${p}`), ...diff].join('\n')}\n(--write rewrites it from live data)`);
  }
  console.log('\ntools/mainnet-canary-policy.json: matches live data');
}

if (isMain(import.meta.url)) await run(main, USAGE);
