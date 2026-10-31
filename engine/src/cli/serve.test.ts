// The serve CLI as a process: it refuses to start on a bad policy file, and listens where GIMBAL_HOST says.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { loadPolicyFile } from './serve-replay.ts';

const SERVE = fileURLToPath(new URL('./serve.ts', import.meta.url));

const GOOD = {
  hl_assets: [{ index: 5, symbol: 'SOL', sz_decimals: 2 }], phoenix_markets: [], orderly_symbols: [],
  max_notional_usd: 5000, price_band_bps: 100, oracle_max_age_s: 60, rescue_cap_usd_per_hour: 500,
  max_transfer_cost_bps: 50, max_transfer_cost_flat_e6: 2_000_000,
};

/** Runs serve until `until` matches its output or it exits; then stops it. */
function run(args: string[], env: Record<string, string>, until: RegExp): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVE, ...args], { env: { ...process.env, GIMBAL_MODE: 'replay', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => child.kill(), 20_000);
    const seen = (chunk: Buffer) => {
      out += chunk.toString('utf8');
      if (until.test(out)) child.kill();
    };
    child.stdout.on('data', seen);
    child.stderr.on('data', seen);
    child.on('error', reject);
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

test('a policy file that does not match ContractPolicy stops the engine before it starts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gimbal-serve-'));
  try {
    const bad = join(dir, 'policy.json');
    writeFileSync(bad, JSON.stringify({ ...GOOD, max_notional_usd: -1 }));
    const r = await run(['--port', '0', '--policy', bad], {}, /listening|engine replay on/);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /serve: policy file .*policy\.json: policy: max_notional_usd must be a number > 0/);
    assert.doesNotMatch(r.out, /engine replay on/);
    // Not JSON at all, and a file that is not there.
    writeFileSync(bad, '{"hl_assets": [');
    assert.throws(() => loadPolicyFile(bad), /policy file .*policy\.json: /);
    assert.throws(() => loadPolicyFile(join(dir, 'missing.json')), /policy file .*missing\.json: /);
    // A good one, without `unpriced`, loads with none.
    writeFileSync(bad, JSON.stringify(GOOD));
    assert.deepEqual(loadPolicyFile(bad).unpriced, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('it listens on 127.0.0.1 by default and on GIMBAL_HOST when set', async () => {
  const plain = await run(['--port', '0'], {}, /engine replay on http:\/\/\S+:\d+/);
  assert.match(plain.out, /engine replay on http:\/\/127\.0\.0\.1:\d+: /);
  const set = await run(['--port', '0'], { GIMBAL_HOST: 'localhost' }, /engine replay on http:\/\/\S+:\d+/);
  assert.match(set.out, /engine replay on http:\/\/localhost:\d+: /);
  // Variables left empty, as .env.example has them, count as not set.
  const empty = { GIMBAL_HOST: '', GIMBAL_POLICY_FILE: '', GIMBAL_REPLAY_FILE: '', GIMBAL_REPLAY_SPEED: '' };
  const blank = await run(['--port', '0'], empty, /engine replay on http:\/\/\S+:\d+/);
  assert.match(blank.out, /engine replay on http:\/\/127\.0\.0\.1:\d+: /);
});

test('replay prices desk legs from the recording on the replay clock: priced legs are not refused E_ORACLE_STALE', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gimbal-serve-'));
  const policyPath = join(dir, 'policy.json');
  writeFileSync(policyPath, JSON.stringify({
    ...GOOD, hl_assets: [{ index: 0, symbol: 'BTC', sz_decimals: 5 }, { index: 1, symbol: 'ETH', sz_decimals: 4 }, { index: 5, symbol: 'SOL', sz_decimals: 2 }],
    orderly_symbols: ['PERP_BTC_USDC', 'PERP_ETH_USDC', 'PERP_SOL_USDC'], oracle_max_age_s: 300,
  }));
  const child = spawn(process.execPath, [SERVE, '--port', '0', '--policy', policyPath], { env: { ...process.env, GIMBAL_MODE: 'replay' }, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    let out = '';
    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`serve did not start: ${out}`)), 20_000);
      const seen = (chunk: Buffer) => {
        out += chunk.toString('utf8');
        const m = /engine replay on http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
        if (m !== null) {
          clearTimeout(timer);
          resolve(Number(m[1]));
        }
      };
      child.stdout.on('data', seen);
      child.stderr.on('data', seen);
      child.on('exit', () => reject(new Error(`serve exited: ${out}`)));
    });
    type W = { symbol: string; longVenue: string; shortVenue: string; refused?: { code: string }; checks: { ok: boolean; text: string }[] };
    const hlOrderly = (w: W) => ['BTC', 'ETH', 'SOL'].includes(w.symbol) && [w.longVenue, w.shortVenue].sort().join() === 'hyperliquid,orderly';
    let priced: W[] = [];
    for (let i = 0; i < 150 && priced.length === 0; i++) {
      const state = (await (await fetch(`http://127.0.0.1:${port}/state`)).json()) as { windows: W[] | null };
      priced = (state.windows ?? []).filter(hlOrderly);
      if (priced.length === 0) await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(priced.length > 0, 'no Hyperliquid-Orderly window on BTC, ETH or SOL');
    for (const w of priced) {
      assert.notEqual(w.refused?.code, 'E_ORACLE_STALE', JSON.stringify(w.refused));
      assert.ok(w.checks.some((c) => c.ok && /The oracle price for .* within the 300 s limit/.test(c.text)), JSON.stringify(w.checks));
    }
  } finally {
    child.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the scanner gets the costs of the mode: testnet prices Orderly under woofi_dex, replay (mainnet answers) under gimbal_dex', async () => {
  // Stopped at the costs line, before the first scan: no venue is read.
  const testnet = await run(['--port', '0'], { GIMBAL_MODE: 'testnet', GIMBAL_CONTRACT_ID: '' }, /scanner costs .*\)\n/);
  assert.match(testnet.out, /scanner costs \(testnet\): taker fill hyperliquid 5\.5 bps, phoenix 3\.5 bps, orderly 4\.5 bps \(Orderly broker woofi_dex\)/);
  const replay = await run(['--port', '0'], {}, /scanner costs .*\)\n/);
  assert.match(replay.out, /scanner costs \(replay\): taker fill hyperliquid 5\.5 bps, phoenix 3\.5 bps, orderly 4 bps \(Orderly broker gimbal_dex\)/);
});
