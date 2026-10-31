// The replay oracle over the committed scanner recording: stored prices are dated by the replay clock, never in the
// scanner's future, so priced desk legs pass the oracle check in replay instead of being refused E_ORACLE_STALE.

import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import type { ContractPolicy } from '@gimbal/shared';
import { replayStart } from '../cli/serve-replay.ts';
import { replayReaders } from '../readers.ts';
import { DEFAULT_SCANNER_CONFIG, DEFAULT_STRATEGY } from '../scanner/config.ts';
import { Scanner } from '../scanner/scanner.ts';
import { VirtualClock, readRecording } from '../venues/replay.ts';
import { ReplayOracle } from './replay-oracle.ts';

const FIXTURES = fileURLToPath(new URL('../../fixtures/replay/', import.meta.url));
const FILE = readdirSync(FIXTURES).filter((f) => f.startsWith('scan-') && f.endsWith('.jsonl.gz')).sort().at(-1)!;
const COINS = ['BTC', 'ETH', 'SOL'];
/** Hyperliquid mainnet asset indexes and size decimals (the recording is mainnet). */
const HL_ASSETS = [{ index: 0, symbol: 'BTC', sz_decimals: 5 }, { index: 1, symbol: 'ETH', sz_decimals: 4 }, { index: 5, symbol: 'SOL', sz_decimals: 2 }];

test('replay: oracle prices carry the replay time, and priced desk legs are not refused for their age', async () => {
  const lines = readRecording(join(FIXTURES, FILE));
  const start = replayStart(lines);
  const policy: ContractPolicy = {
    hl_assets: HL_ASSETS,
    phoenix_markets: [], orderly_symbols: COINS.map((c) => `PERP_${c}_USDC`),
    max_notional_usd: 10_000, price_band_bps: 200, oracle_max_age_s: 300, rescue_cap_usd_per_hour: 1000,
    unpriced: [], unpriced_max_notional_usd: 100, max_transfer_cost_bps: 50, max_transfer_cost_flat_e6: 1_000_000,
  };
  const clock = new VirtualClock(start);
  const oracle = new ReplayOracle(clock);
  const readers = replayReaders(lines, clock);
  const venues = readers.venues.map((v) => oracle.tap(v));
  const scanner = new Scanner(venues, readers.watch, { config: { ...DEFAULT_SCANNER_CONFIG, policy }, clock, oracle, strategy: () => DEFAULT_STRATEGY });

  let priced = 0;
  for (let t = start; t <= start + 120_000; t += 5_000) {
    clock.set(t);
    const r = await scanner.scan();
    await scanner.idle();
    for (const c of COINS) {
      const p = oracle.price('hyperliquid', c);
      assert.ok(p !== null, `${c} has a stored price at ${t}`);
      assert.ok(p.at <= clock.now() && p.at > clock.now() - 300_000, `${c} dated ${p.at}, replay time ${clock.now()}, wall clock ${Date.now()}`);
      assert.ok(Math.abs(oracle.price('orderly', `PERP_${c}_USDC`)!.px - p.px) < 1e-9);
    }
    for (const w of r.windows) {
      const venues = [w.longVenue, w.shortVenue].sort().join(' ');
      if (venues !== 'hyperliquid orderly' || !COINS.includes(w.symbol) || !w.tradable) continue;
      priced++;
      assert.notEqual(w.refused?.code, 'E_ORACLE_STALE', `${w.id}: ${w.refused?.reason}`);
      assert.ok(w.checks.some((c) => c.ok && /The oracle price for .* s old, within the 300 s limit/.test(c.text)), w.id);
    }
  }
  assert.ok(priced > 0, 'no Hyperliquid-Orderly window on BTC, ETH or SOL in the recording');
});
